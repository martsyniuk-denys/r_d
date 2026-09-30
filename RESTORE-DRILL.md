# Restore drill — 2026-09-30

A backup nobody has restored is a file, not a backup. This is the record of the
run that turned the marketplace dump into a database again and checked, value by
value, that it was the same database.

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## What was drilled

| | |
|---|---|
| Date | 2026-09-30, 21:44 EEST |
| Source | `marketplace` on `postgres:16-alpine`, reached through PgBouncer on `127.0.0.1:56432` |
| Dump | `backups/marketplace-2026-09-30_214417.dump`, `pg_dump -Fc --compress=9` |
| Dump size | 19 400 bytes (20 KB), 46 TOC entries |
| Database size | 8 031 kB |
| Rows | users 8, products 12, orders 10, order_items 22, jobs 0, migrations 2 — a clean `npm run migrate && npm run seed` |
| Target | throwaway `postgres:18-alpine` container on a named volume created by the script and removed with it |
| Host | macOS 27.0, arm64, Docker 29.1.3 |

The restore target is a volume that did not exist when the script started:
`docker volume create marketplace-restore-drill-<timestamp>-<pid>`, thrown away by
an `EXIT` trap. That is the point — a restore into a volume that already holds
data proves nothing except that `duplicate key` errors are real.

## Control value

One line, taken twice, compared as a string:

```sql
SELECT count(*) || '|' || coalesce(sum(qty * unit_price_minor), 0) FROM order_items;
```

`order_items` is where the money is: a row count alone would survive a truncated
restore of the amounts, and a sum alone would survive missing rows.

| | |
|---|---|
| Before — recorded next to the dump at dump time | `22\|4556700` |
| After — read out of the restored database | `22\|4556700` |
| Verdict | **MATCH** (exit code 0) |

The "before" value is not read from the live database at drill time on purpose.
The live database keeps moving; the question a drill has to answer is whether the
dump still holds what the database held *when the dump was taken*, so
`scripts/backup.sh` writes that value into a `.checksum` sidecar and the drill
compares against it.

## Measurements

| Step | Time |
|---|---|
| Volume created, container started, first connection accepted | 1.6 s |
| `pg_restore --no-owner --no-acl --exit-on-error` | 0.1 s |
| Checksum read back | < 0.1 s |
| **End to end** | **1.7 s** |

Three consecutive runs gave the same 1.7 s, so the number is the drill's cost and not
a warm-cache artefact. The negative case was exercised too: with a deliberately corrupted sidecar the
drill printed `MISMATCH` and exited 1, so the `MATCH` above is a result and not a
script that always succeeds.

## RTO and RPO

**RTO (recovery time objective): 1.7 seconds measured, 15 minutes committed.**
The measured number is the honest one for *this* dataset — 20 KB, one container,
an image already in the local cache. The committed number carries what the drill
deliberately leaves out: pulling the Postgres image on a cold host (≈1–2 minutes),
fetching the dump from wherever it lives once it stops living on the same disk
(#26 moves it to S3), pointing PgBouncer at the restored instance, and a human
deciding to press the button. Restore time grows roughly with dump size, so the
margin is what covers the catalogue growing by three orders of magnitude before
this document is rewritten.

**RPO (recovery point objective): 24 hours.** `backup.cron` runs the dump once a
night at 03:15, and nothing else captures writes — no WAL archiving, no streaming
replica. A failure at 03:14 therefore loses 23 hours 59 minutes of orders. That is
the true number for the current schedule, and it is stated rather than softened
because the next lectures are where it gets cut: continuous WAL archiving takes
the RPO to minutes, a replica takes it to seconds.

## What this drill does not prove yet

- The dump lives on the same machine as the database. A disk that takes Postgres
  with it takes the backup too — offsite storage is #26.
- No point-in-time recovery: a custom-format dump restores exactly one moment,
  the moment it was taken.
- Only `order_items` is checksummed. It is the table the domain hangs on, but a
  restore that silently lost `jobs` rows would still print MATCH.
- The drill restores into a throwaway container, not into a promoted instance the
  application is then repointed at. Failover is a separate exercise.
