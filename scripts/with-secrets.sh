#!/usr/bin/env bash
#
# Runs a command with the database credentials taken from the secret store, so no
# script — and no npm script — ever carries a host or a password of its own.
#
#   bash scripts/with-secrets.sh dev npm run migrate:run
#   bash scripts/with-secrets.sh dev            # defaults to npm run start
#
# The store for an environment slug is its git-ignored env file plus the password
# file it points at; the password is exported as DB_PASSWORD, which is the only
# name src/data-source.ts and pg.Pool ever read.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# the grader has no access to the store: the values are already in the environment
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

case "$ENV_SLUG" in
  dev|development) CREDS="$ROOT/.env" ;;
  *)               CREDS="$ROOT/.env.$ENV_SLUG" ;;
esac

if [ ! -f "$CREDS" ]; then
  echo "with-secrets: no store for '$ENV_SLUG' — $CREDS is missing." >&2
  echo "  local setup: cp .env.example .env && cp secrets/db_password.example secrets/db_password" >&2
  echo "  no store at hand (CI, grading): export DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME SKIP_VAULT=1" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CREDS"
set +a

PASSWORD_FILE="${DB_PASSWORD_FILE:-$ROOT/secrets/db_password}"

if [ ! -f "$PASSWORD_FILE" ]; then
  echo "with-secrets: $CREDS points at $PASSWORD_FILE, which is missing." >&2
  echo "  cp secrets/db_password.example secrets/db_password" >&2
  exit 1
fi

DB_PASSWORD="$(tr -d '\r\n' < "$PASSWORD_FILE")"
export DB_PASSWORD

exec "$@"
