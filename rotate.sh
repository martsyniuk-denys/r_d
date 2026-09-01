#!/usr/bin/env bash
#
# Rotates the Postgres password without restarting the API.
#
#   1. ALTER ROLE          — the database accepts the new password
#   2. write the file      — pg re-reads it for every NEW connection
#   3. pg_terminate_backend — old connections are dropped and reopened with it
#
# The order matters: if the file were written first, every new connection would
# authenticate with a password the database does not know yet.

set -euo pipefail

CONTAINER="${CONTAINER:-marketplace-postgres}"
DB_USER="${DB_USER:-marketplace}"
DB_NAME="${DB_NAME:-marketplace}"
PASSWORD_FILE="${PASSWORD_FILE:-./secrets/db_password}"

new_password="rotated_$(date +%s)_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"

psql() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

echo "1/3  ALTER ROLE $DB_USER — teaching the database the new password"
psql -q -c "ALTER ROLE ${DB_USER} WITH PASSWORD '${new_password}';"

echo "2/3  writing $PASSWORD_FILE — pg picks it up on the next connection"
printf '%s' "$new_password" > "$PASSWORD_FILE"

echo "3/3  pg_terminate_backend — dropping connections opened with the old password"
psql -q -t -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = '${DB_NAME}'
    AND usename = '${DB_USER}'
    AND pid <> pg_backend_pid()
    AND application_name <> 'psql';" > /dev/null

echo
echo "Rotation done. The API was not restarted: the pool simply reconnects and"
echo "re-reads $PASSWORD_FILE for each new connection."
