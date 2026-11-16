#!/usr/bin/env bash
#
#   bash scripts/store-ci.sh init     # a new key + new random values → store/ci.enc
#   bash scripts/store-ci.sh names    # the names inside store/ci.enc, never the values
#
# The store of the `ci` slug (scripts/with-secrets.sh ci …): NAME=value lines,
# AES-256-CBC with PBKDF2, in git as ciphertext only. Its key stays in
# secrets/ci_store_key (git-ignored, like every other file of the local store) and,
# for the pipeline, in the `kind` environment's secret STORE_KEY:
#
#   gh secret set STORE_KEY --env kind < secrets/ci_store_key
#
# The values are made for CI and guard only the stand CI raises in its runner; none
# of them is the dev store's value.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="$ROOT/secrets/ci_store_key"
STORE="$ROOT/store/ci.enc"

case "${1:-}" in
  init)
    umask 077
    openssl rand -hex 32 > "$KEY_FILE"
    {
      echo "# the database password the pods read through a K8s Secret"
      echo "DB_PASSWORD=$(openssl rand -hex 24)"
      echo "# encrypts the Pulumi state of the stack CI raises"
      echo "PULUMI_CONFIG_PASSPHRASE=$(openssl rand -hex 24)"
    } | STORE_KEY="$(cat "$KEY_FILE")" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$STORE" -pass env:STORE_KEY
    echo "store/ci.enc written; key in secrets/ci_store_key — gh secret set STORE_KEY --env kind < secrets/ci_store_key"
    ;;
  names)
    STORE_KEY="$(cat "$KEY_FILE")" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$STORE" -pass env:STORE_KEY \
      | grep -vE '^(#|$)' | cut -d= -f1
    ;;
  *)
    echo "usage: $0 init|names" >&2
    exit 2
    ;;
esac
