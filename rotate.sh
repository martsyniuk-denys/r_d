#!/usr/bin/env bash
#
# Rotates the Postgres password without restarting the API.
#
#   1. ALTER ROLE          — the database accepts the new password
#   2. userlist + RELOAD   — PgBouncer logs in to Postgres with it, and checks
#                            its own clients against it
#   3. write the file      — pg re-reads it for every NEW connection
#   4. pg_terminate_backend — old connections are dropped and reopened with it
#
# The order matters: if the file were written first, every new connection would
# authenticate with a password the database does not know yet; and if PgBouncer
# were left out, the pooler would keep offering Postgres a password it no longer
# has — since #15 the application talks to the pooler, not to Postgres.

set -euo pipefail

CONTAINER="${CONTAINER:-marketplace-postgres}"
DB_USER="${DB_USER:-marketplace}"
DB_NAME="${DB_NAME:-marketplace}"
PASSWORD_FILE="${PASSWORD_FILE:-./secrets/db_password}"
USERLIST="${USERLIST:-./pgbouncer/userlist.txt}"

new_password="rotated_$(date +%s)_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"

psql() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

echo "1/4  ALTER ROLE $DB_USER — teaching the database the new password"
psql -q -c "ALTER ROLE ${DB_USER} WITH PASSWORD '${new_password}';"

echo "2/4  rewriting $USERLIST and reloading PgBouncer"
# truncated in place: the file is bind-mounted into the container by inode, so
# replacing it with mv would leave the pooler reading the old one
userlist="$(sed "s|^\"${DB_USER}\" \".*\"\$|\"${DB_USER}\" \"${new_password}\"|" "$USERLIST")"
printf '%s\n' "$userlist" > "$USERLIST"
docker compose kill -s SIGHUP pgbouncer >/dev/null 2>&1

echo "3/4  writing $PASSWORD_FILE — pg picks it up on the next connection"
printf '%s' "$new_password" > "$PASSWORD_FILE"

echo "4/4  pg_terminate_backend — dropping connections opened with the old password"
psql -q -t -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = '${DB_NAME}'
    AND usename = '${DB_USER}'
    AND pid <> pg_backend_pid()
    AND application_name <> 'psql';" > /dev/null

echo
echo "Rotation done. Nothing was restarted: the pool re-reads $PASSWORD_FILE for"
echo "each new connection, and PgBouncer re-read its userlist on SIGHUP."
echo
echo "$USERLIST is a tracked file carrying development credentials, so this leaves"
echo "the working tree dirty on purpose — in production it comes from the store."
