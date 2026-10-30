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
#
# The same store holds the token keys of the slug, in secrets/jwt/<slug>/ (see
# scripts/jwt-keys.mjs). The PEMs are exported base64-encoded, because a
# multi-line value does not survive every shell. A store without them is not an
# error here — migrate and seed do not need them — but the API refuses to start
# and names the variable that is missing.

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
  echo "               (broker: uncomment BROKER_URL in .env, cp secrets/broker_password.example secrets/broker_password)" >&2
  echo "               (redis: uncomment REDIS_URL/REDIS_QUEUE_URL in .env, cp secrets/redis_password.example secrets/redis_password)" >&2
  echo "               (tokens: node scripts/jwt-keys.mjs generate $ENV_SLUG)" >&2
  echo "  no store at hand (CI, grading): export DATABASE_URL BROKER_URL REDIS_URL REDIS_QUEUE_URL JWT_* REFRESH_TOKEN_PEPPER SKIP_VAULT=1" >&2
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

case "$ENV_SLUG" in
  dev|development) JWT_DIR="$ROOT/secrets/jwt/dev" ;;
  *)               JWT_DIR="$ROOT/secrets/jwt/$ENV_SLUG" ;;
esac

if [ -f "$JWT_DIR/private.pem" ]; then
  JWT_PRIVATE_KEY="$(base64 < "$JWT_DIR/private.pem" | tr -d '\r\n')"
  JWT_PUBLIC_KEY="$(base64 < "$JWT_DIR/public.pem" | tr -d '\r\n')"
  JWT_KID="$(tr -d '\r\n' < "$JWT_DIR/kid")"
  REFRESH_TOKEN_PEPPER="$(tr -d '\r\n' < "$JWT_DIR/pepper")"
  export JWT_PRIVATE_KEY JWT_PUBLIC_KEY JWT_KID REFRESH_TOKEN_PEPPER

  if [ -f "$JWT_DIR/previous/public.pem" ]; then
    JWT_PREVIOUS_PUBLIC_KEY="$(base64 < "$JWT_DIR/previous/public.pem" | tr -d '\r\n')"
    JWT_PREVIOUS_KID="$(tr -d '\r\n' < "$JWT_DIR/previous/kid")"
    export JWT_PREVIOUS_PUBLIC_KEY JWT_PREVIOUS_KID
  fi
fi

exec "$@"
