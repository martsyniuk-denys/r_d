#!/usr/bin/env bash
#
# Turns whatever the secret store (or the grader) put in the environment into the
# PG* variables every libpq tool understands, so backup.sh and restore-drill.sh
# carry no host, no user and no password of their own.
#
#   DATABASE_URL          — one URL, password included (what the grader exports)
#   DB_URL + DB_PASSWORD  — the shape of this project since #11: URL without a
#                           password, password from the store or DB_PASSWORD_FILE
#   DB_HOST/DB_PORT/DB_USER/DB_NAME + DB_PASSWORD — the discrete form CI uses

HINT='No connection in the environment. Either go through the store — bash scripts/with-secrets.sh dev bash scripts/<script>.sh — or export DATABASE_URL yourself together with SKIP_VAULT=1.'

# %40 → @ and friends: a URL that carries credentials has them percent-encoded.
# Backslashes are doubled first so printf %b leaves them alone.
urldecode() {
  local raw="${1//\\/\\\\}"
  printf '%b' "${raw//%/\\x}"
}

pg_password() {
  if [ -n "${DB_PASSWORD:-}" ]; then printf '%s' "$DB_PASSWORD"; return; fi
  if [ -n "${DB_PASSWORD_FILE:-}" ] && [ -f "${DB_PASSWORD_FILE}" ]; then
    tr -d '\r\n' < "$DB_PASSWORD_FILE"; return
  fi
  printf ''
}

pg_env_load() {
  local url="${DATABASE_URL:-${DB_URL:-}}"

  if [ -n "$url" ]; then
    local rest userinfo hostport
    rest="${url#*://}"
    if [[ "$rest" == *"@"* ]]; then userinfo="${rest%%@*}"; rest="${rest#*@}"; else userinfo=""; fi
    hostport="${rest%%/*}"

    PGUSER="$(urldecode "${userinfo%%:*}")"
    PGHOST="${hostport%%:*}"
    PGPORT="${hostport##*:}"
    [ "$PGPORT" = "$PGHOST" ] && PGPORT=5432
    PGDATABASE="${rest#*/}"; PGDATABASE="${PGDATABASE%%\?*}"

    # a password inside the URL wins: it is the only thing the grader exports
    if [[ "$userinfo" == *":"* ]]; then PGPASSWORD="$(urldecode "${userinfo#*:}")"; else PGPASSWORD="$(pg_password)"; fi
  else
    PGHOST="${DB_HOST:-}"
    PGPORT="${DB_PORT:-5432}"
    PGUSER="${DB_USER:-}"
    PGDATABASE="${DB_NAME:-}"
    PGPASSWORD="$(pg_password)"
  fi

  if [ -z "${PGHOST:-}" ] || [ -z "${PGUSER:-}" ] || [ -z "${PGDATABASE:-}" ]; then
    echo "DATABASE_URL: unbound variable" >&2
    echo "$HINT" >&2
    exit 1
  fi

  export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
}

# Count plus a money aggregate over the table the whole domain hangs on. One line,
# taken before the dump and after the restore, compared as a string.
CHECKSUM_SQL="SELECT count(*) || '|' || coalesce(sum(qty * unit_price_minor), 0) FROM order_items"

require_tool() {
  command -v "$1" >/dev/null 2>&1 && return 0
  echo "$1 is not on PATH — the Postgres client tools are needed to run this script." >&2
  echo "  macOS: brew install libpq && brew link --force libpq   Debian: apt-get install postgresql-client" >&2
  exit 1
}
