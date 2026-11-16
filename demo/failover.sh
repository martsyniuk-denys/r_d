#!/usr/bin/env bash
#
#   npm run demo:failover
#
# Multi-AZ is not a checkbox: reboot the primary with --force-failover and show the
# endpoint now lives in the other zone. Writes to evidence/demos.txt:
#
#   az-before / az-after   AvailabilityZone of the instance before and after
#   failover-seconds       from the reboot call to `available` in the new zone
#   event                  the failover line from describe-events
#
# This is a controlled switch — the procedure is measured, not an incident. The
# failover itself adds nothing to the bill: the standby is already paid for.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/aws.sh"
refuse_emulator demo:failover

R="$(demo_region)"; DB="$(demo_output dbIdentifier)"
q() { aws rds describe-db-instances --region "$R" --db-instance-identifier "$DB" --query "DBInstances[0].$1" --output text; }

# --force-failover refuses an instance that is not `available` (e.g. `modifying`):
# wait, do not retry the reboot.
until [ "$(q DBInstanceStatus)" = available ]; do echo "waiting: $(q DBInstanceStatus)"; sleep 10; done
[ "$(q MultiAZ)" = True ] || { echo "demo:failover: $DB is not Multi-AZ" >&2; exit 1; }

before="$(q AvailabilityZone)"
echo "primary in $before, standby in $(q SecondaryAvailabilityZone)"
t0=$(date +%s)
aws rds reboot-db-instance --region "$R" --db-instance-identifier "$DB" --force-failover >/dev/null

# Done when the instance is available again and its zone is no longer the old one.
while :; do
  sleep 5
  st="$(q DBInstanceStatus)"; az="$(q AvailabilityZone)"
  echo "  +$(( $(date +%s) - t0 ))s status=$st az=$az"
  [ "$st" = available ] && [ "$az" != "$before" ] && break
  [ $(( $(date +%s) - t0 )) -lt 900 ] || { echo "demo:failover: no failover after 15 min" >&2; exit 1; }
done
secs=$(( $(date +%s) - t0 ))

event="$(aws rds describe-events --region "$R" --source-type db-instance --source-identifier "$DB" \
          --duration 30 --query 'Events[?contains(Message, `failover`)].Message | [-1]' --output text)"

put az-before "$before"
put az-after "$az"
put failover-seconds "$secs"
put event "$event"
[ "$secs" -ge 60 ] && [ "$secs" -le 120 ] || echo "note: $secs s is outside the documented 60–120 s — README says so"
