#!/usr/bin/env bash
#
# Restore drill: proves the latest dump is a database, not a file.
#
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
#
# Takes the newest dump, brings up a Postgres container on a volume that did not
# exist a second ago, restores into it, and compares the control value of the
# restored data with the one recorded when the dump was taken. Prints MATCH, or
# exits non-zero. The container and the volume are removed either way, so the
# drill is repeatable and leaves nothing behind.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/pg-env.sh
. "$ROOT/scripts/lib/pg-env.sh"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DRILL_USER=drill
DRILL_DB=drill
DRILL_PASSWORD=drill
SUFFIX="$(date +%s)-$$"
DRILL_CONTAINER="marketplace-restore-drill-$SUFFIX"
DRILL_VOLUME="marketplace-restore-drill-$SUFFIX"

# Wall clock in milliseconds: a drill that finishes in two seconds deserves a
# more honest RTO than "0s". EPOCHREALTIME needs bash 5, hence the fallbacks.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    printf '%s' "${EPOCHREALTIME//[.,]/}" | cut -c1-13
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

since() { awk -v ms="$(( $(now_ms) - $1 ))" 'BEGIN { printf "%.1fs", ms / 1000 }'; }

require_tool pg_restore
require_tool psql
require_tool docker
pg_env_load

# A custom archive is only readable by a pg_restore of its own major version or
# newer, and a newer pg_restore emits SET options an older server rejects. So the
# drill server is the major version of the client tools that made the dump.
CLIENT_MAJOR="$(pg_restore --version | grep -oE '[0-9]+' | head -1)"
DRILL_IMAGE="${DRILL_IMAGE:-postgres:$CLIENT_MAJOR-alpine}"

DUMP="$(ls -t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if [ -z "$DUMP" ]; then
  echo "No dump in $BACKUP_DIR — run bash scripts/backup.sh first." >&2
  exit 1
fi

cleanup() {
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$DRILL_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "dump:     $DUMP ($(du -h "$DUMP" | cut -f1 | tr -d ' '))"

if [ -f "$DUMP.checksum" ]; then
  EXPECTED="$(cut -d' ' -f2 < "$DUMP.checksum")"
  echo "expected: $EXPECTED  (recorded when the dump was taken)"
else
  EXPECTED="$(psql -qtAX -c "$CHECKSUM_SQL")"
  echo "expected: $EXPECTED  (read from $PGHOST:$PGPORT/$PGDATABASE — no sidecar next to the dump)"
fi

STARTED_AT="$(now_ms)"

echo "1/4  empty volume $DRILL_VOLUME and a fresh $DRILL_IMAGE container"
docker volume create "$DRILL_VOLUME" >/dev/null
docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER="$DRILL_USER" \
  -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
  -e POSTGRES_DB="$DRILL_DB" \
  -v "$DRILL_VOLUME:/var/lib/postgresql" \
  -p 127.0.0.1::5432 \
  "$DRILL_IMAGE" >/dev/null

DRILL_PORT="$(docker port "$DRILL_CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"

echo "2/4  waiting for it to accept connections on 127.0.0.1:$DRILL_PORT"
# from the host, over TCP: while the image initialises the fresh volume it runs a
# temporary server on the unix socket only, and a socket-side check inside the
# container would call that ready a second too early
ready=no
for _ in $(seq 1 90); do
  if pg_isready -h 127.0.0.1 -p "$DRILL_PORT" -U "$DRILL_USER" -d "$DRILL_DB" >/dev/null 2>&1; then
    ready=yes; break
  fi
  sleep 1
done
if [ "$ready" != yes ]; then
  echo "The drill container never started listening. Its log:" >&2
  docker logs --tail 30 "$DRILL_CONTAINER" >&2
  exit 1
fi

echo "3/4  pg_restore --no-owner into the empty database"
RESTORE_FROM="$(now_ms)"
PGPASSWORD="$DRILL_PASSWORD" pg_restore \
  --no-owner --no-acl --exit-on-error \
  -h 127.0.0.1 -p "$DRILL_PORT" -U "$DRILL_USER" -d "$DRILL_DB" "$DUMP"
RESTORE_TOOK="$(since "$RESTORE_FROM")"

echo "4/4  reading the same control value back out of the restored database"
ACTUAL="$(PGPASSWORD="$DRILL_PASSWORD" psql -h 127.0.0.1 -p "$DRILL_PORT" -U "$DRILL_USER" -d "$DRILL_DB" -qtAX -c "$CHECKSUM_SQL")"

TOTAL_TOOK="$(since "$STARTED_AT")"

echo
echo "order_items before: $EXPECTED"
echo "order_items after:  $ACTUAL"
echo "pg_restore: $RESTORE_TOOK    drill end to end (measured RTO): $TOTAL_TOOK"
echo

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "MISMATCH — the restored database is not the database that was dumped." >&2
  exit 1
fi

echo "MATCH"
