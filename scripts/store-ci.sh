#!/usr/bin/env bash
#
#   bash scripts/store-ci.sh init     # a new key + new random values → store/ci.enc
#   bash scripts/store-ci.sh fill     # the same key; values only for the names missing
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

# One line per name, a fresh value each: everything the kind stand needs.
NAMES="DB_PASSWORD PULUMI_CONFIG_PASSPHRASE BROKER_PASSWORD STORAGE_SECRET_KEY JWT_PRIVATE_KEY REFRESH_TOKEN_PEPPER PAYMENT_WEBHOOK_SECRET"

# JWT_PRIVATE_KEY brings JWT_PUBLIC_KEY and JWT_KID with it: the three go together.
generate() {
  case "$1" in
    DB_PASSWORD)
      echo "# the database password: Postgres in kind and the pods, through a K8s Secret"
      echo "DB_PASSWORD=$(openssl rand -hex 24)" ;;
    PULUMI_CONFIG_PASSPHRASE)
      echo "# encrypts the Pulumi state of the stack CI raises"
      echo "PULUMI_CONFIG_PASSPHRASE=$(openssl rand -hex 24)" ;;
    BROKER_PASSWORD)
      echo "# RabbitMQ in kind, and the API, relay and consumer that log in to it"
      echo "BROKER_PASSWORD=$(openssl rand -hex 24)" ;;
    STORAGE_SECRET_KEY)
      echo "# required by the API's config; no object storage runs in kind"
      echo "STORAGE_SECRET_KEY=$(openssl rand -hex 24)" ;;
    JWT_PRIVATE_KEY)
      local pem
      pem="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)"
      echo "# the ES256 signing key of the API in kind (base64 PEMs, as the app reads them)"
      echo "JWT_PRIVATE_KEY=$(printf '%s\n' "$pem" | base64 | tr -d '\n')"
      echo "JWT_PUBLIC_KEY=$(printf '%s\n' "$pem" | openssl pkey -pubout 2>/dev/null | base64 | tr -d '\n')"
      echo "JWT_KID=ci-$(date -u +%Y-%m-%d)-$(openssl rand -hex 3)" ;;
    REFRESH_TOKEN_PEPPER)
      echo "REFRESH_TOKEN_PEPPER=$(openssl rand -hex 32)" ;;
    PAYMENT_WEBHOOK_SECRET)
      echo "# the HMAC key the contour smoke signs its webhooks with"
      echo "PAYMENT_WEBHOOK_SECRET=$(openssl rand -hex 32)" ;;
  esac
}

decrypt() {
  STORE_KEY="$(cat "$KEY_FILE")" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$STORE" -pass env:STORE_KEY
}

encrypt() {
  STORE_KEY="$(cat "$KEY_FILE")" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$STORE" -pass env:STORE_KEY
}

case "${1:-}" in
  init)
    umask 077
    openssl rand -hex 32 > "$KEY_FILE"
    for name in $NAMES; do generate "$name"; done | encrypt
    echo "store/ci.enc written; key in secrets/ci_store_key — gh secret set STORE_KEY --env kind < secrets/ci_store_key"
    ;;
  fill)
    current="$(decrypt)"
    added=""
    for name in $NAMES; do
      grep -q "^$name=" <<< "$current" && continue
      current="$current"$'\n'"$(generate "$name")"
      added="$added $name"
    done
    printf '%s\n' "$current" | encrypt
    echo "store/ci.enc: added${added:- nothing}; the key is unchanged"
    ;;
  names)
    decrypt | grep -vE '^(#|$)' | cut -d= -f1
    ;;
  *)
    echo "usage: $0 init|fill|names" >&2
    exit 2
    ;;
esac
