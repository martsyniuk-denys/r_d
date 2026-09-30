#!/usr/bin/env bash
#
# Nightly backup: pg_dump -Fc of the coursework database into a dated file.
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh
#
# The connection comes from the environment the wrapper fills (#11). Nothing here
# knows a host or a password. Next to every dump the script writes a .checksum
# sidecar — the control value of the data as it was at dump time, which is what
# scripts/restore-drill.sh later compares the restored database against.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/pg-env.sh
. "$ROOT/scripts/lib/pg-env.sh"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

require_tool pg_dump
require_tool psql
pg_env_load

# pg_dump needs one session for the whole dump, and transaction pooling does not
# promise it one. pgbouncer.ini publishes the same database a second time in
# session mode for exactly this; when it is not there — a direct Postgres URL, for
# instance — the configured database is already a session of its own.
dump_database() {
  if psql -d "${PGDATABASE}_session" -qtAX -c 'SELECT 1' >/dev/null 2>&1; then
    printf '%s' "${PGDATABASE}_session"
  else
    printf '%s' "$PGDATABASE"
  fi
}

SOURCE_DB="$(dump_database)"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DUMP="$BACKUP_DIR/marketplace-$STAMP.dump"

mkdir -p "$BACKUP_DIR"

echo "1/3  pg_dump -Fc $PGHOST:$PGPORT/$SOURCE_DB → $DUMP"
pg_dump --format=custom --compress=9 --dbname="$SOURCE_DB" --file="$DUMP"

echo "2/3  recording the control value of the data being dumped"
CHECKSUM="$(psql -d "$SOURCE_DB" -qtAX -c "$CHECKSUM_SQL")"
printf 'order_items %s\n' "$CHECKSUM" > "$DUMP.checksum"

echo "3/3  dropping dumps older than $RETAIN_DAYS days"
find "$BACKUP_DIR" -name 'marketplace-*.dump*' -type f -mtime "+$RETAIN_DAYS" -delete

SIZE="$(du -h "$DUMP" | cut -f1 | tr -d ' ')"

echo
echo "backup: $DUMP"
echo "size:   $SIZE"
echo "order_items checksum (count|sum of qty * unit_price_minor): $CHECKSUM"
echo "verify: pg_restore --list \"$DUMP\" | head"
