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

# The CI slug. A runner has no .env and no secrets/: its store is store/ci.enc,
# AES-256 under STORE_KEY — the one value of this store that GitHub holds (a secret
# of the `kind` environment). The plaintext never touches the runner's disk: it is
# decrypted into this process, exported, and the key is dropped before the command
# runs, so neither the app nor Pulumi ever sees it. See scripts/store-ci.sh.
if [ "$ENV_SLUG" = "ci" ]; then
  if [ -z "${STORE_KEY:-}" ]; then
    echo "with-secrets: STORE_KEY is not set — the key of store/ci.enc (in CI: secrets.STORE_KEY of the kind environment)" >&2
    exit 1
  fi
  if ! plain="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ROOT/store/ci.enc" -pass env:STORE_KEY 2>/dev/null)"; then
    echo "with-secrets: store/ci.enc does not decrypt with this STORE_KEY" >&2
    exit 1
  fi
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    name="${line%%=*}"
    if ! [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
      echo "with-secrets: store/ci.enc has a line that is not NAME=value" >&2
      exit 1
    fi
    export "$name=${line#*=}"
  done <<< "$plain"
  unset plain line name STORE_KEY
  exec "$@"
fi

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
  echo "               (files: STORAGE_* in .env, cp secrets/storage_secret_key.example secrets/storage_secret_key)" >&2
  echo "               (cluster: openssl rand -hex 24 > secrets/pulumi_passphrase)" >&2
  echo "               (aws: AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_KEY_FILE in .env, cp secrets/aws_secret_access_key.example secrets/aws_secret_access_key)" >&2
  echo "               (observability: OTEL_EXPORTER_OTLP_ENDPOINT, PROMETHEUS_URL, TRACE_API_URL, GRAFANA_* in .env, openssl rand -hex 16 > secrets/grafana_admin_password)" >&2
  echo "  no store at hand (CI, grading): export DATABASE_URL BROKER_URL REDIS_URL REDIS_QUEUE_URL JWT_* REFRESH_TOKEN_PEPPER STORAGE_* OTEL_EXPORTER_OTLP_ENDPOINT PROMETHEUS_URL TRACE_API_URL GRAFANA_* SKIP_VAULT=1" >&2
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

# The object-storage secret key lives in a file next to db_password, named by
# STORAGE_SECRET_KEY_FILE in the env file, and is exported as STORAGE_SECRET_KEY.
if [ -n "${STORAGE_SECRET_KEY_FILE:-}" ]; then
  if [ ! -f "$STORAGE_SECRET_KEY_FILE" ]; then
    echo "with-secrets: $CREDS points at $STORAGE_SECRET_KEY_FILE, which is missing." >&2
    echo "  cp secrets/storage_secret_key.example secrets/storage_secret_key" >&2
    exit 1
  fi
  STORAGE_SECRET_KEY="$(tr -d '\r\n' < "$STORAGE_SECRET_KEY_FILE")"
  export STORAGE_SECRET_KEY
fi

# The AWS secret key of the stand (the fallback lane: LocalStack's `test`) lives in a
# file named by AWS_SECRET_KEY_FILE and is exported as AWS_SECRET_ACCESS_KEY.
# CI never comes here: there the credentials are short-lived, from the OIDC role.
# AWS_SECRET_KEY_FILE is the name in .env.example; the older AWS_SECRET_ACCESS_KEY_FILE
# still works in a store written before HW-32.
AWS_SECRET_KEY_FILE="${AWS_SECRET_KEY_FILE:-${AWS_SECRET_ACCESS_KEY_FILE:-}}"
if [ -n "$AWS_SECRET_KEY_FILE" ]; then
  if [ ! -f "$AWS_SECRET_KEY_FILE" ]; then
    echo "with-secrets: $CREDS points at $AWS_SECRET_KEY_FILE, which is missing." >&2
    echo "  cp secrets/aws_secret_access_key.example secrets/aws_secret_access_key" >&2
    exit 1
  fi
  AWS_SECRET_ACCESS_KEY="$(tr -d '\r\n' < "$AWS_SECRET_KEY_FILE")"
  export AWS_SECRET_ACCESS_KEY
fi

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

# The key that encrypts the Pulumi state of the cluster stack (scripts/pulumi.sh).
# Like the JWT keys, a store without it is not an error for everything else.
if [ -f "$ROOT/secrets/pulumi_passphrase" ]; then
  PULUMI_CONFIG_PASSPHRASE="$(tr -d '\r\n' < "$ROOT/secrets/pulumi_passphrase")"
  export PULUMI_CONFIG_PASSPHRASE
fi

# The Grafana admin password of the observability stand (observability/compose.yml
# interpolates it). The addresses next to it — OTEL_EXPORTER_OTLP_ENDPOINT,
# PROMETHEUS_URL, TRACE_API_URL, GRAFANA_URL, GRAFANA_ADMIN_USER — are plain lines
# of the store's .env and arrive with it above.
if [ -f "$ROOT/secrets/grafana_admin_password" ]; then
  GRAFANA_ADMIN_PASSWORD="$(tr -d '\r\n' < "$ROOT/secrets/grafana_admin_password")"
  export GRAFANA_ADMIN_PASSWORD
fi

exec "$@"
