#!/usr/bin/env bash
#
#   npm run demo:nat
#
# What a NAT costs that you do not have: raise one behind hw31:withNat=true, tear it
# down at once, and put two numbers side by side in evidence/demos.txt:
#
#   nat-minutes       how long it lived (CreateTime → DeleteTime, rounded up)
#   nat-billed-hours  what AWS bills: "Each partial NAT Gateway-hour consumed is
#                     billed as a full hour" — so 4 minutes are 1 hour
#
# The exercise costs one billed NAT-hour ($0.052) plus its public IPv4 ($0.005).

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/aws.sh"
refuse_emulator demo:nat

R="$(demo_region)"
set_flag() { (cd "$ROOT/infra/demo" && pulumi config set hw31:withNat "$1" --stack demo); }
# The flag goes back to false whatever happens below: a NAT left up is $37.96 a month.
trap 'set_flag false; bash "$ROOT/scripts/aws.sh" demo up >/dev/null' EXIT

set_flag true
bash "$ROOT/scripts/aws.sh" demo up >/dev/null
ID="$(demo_output natGatewayId)"
echo "NAT $ID is up; tearing it down"

set_flag false
bash "$ROOT/scripts/aws.sh" demo up >/dev/null
trap - EXIT

# A deleted NAT stays visible in describe-nat-gateways for about an hour, with both times.
read -r created deleted < <(aws ec2 describe-nat-gateways --region "$R" --nat-gateway-ids "$ID" \
  --query 'NatGateways[0].[CreateTime,DeleteTime]' --output text)
secs=$(( $(date -d "$deleted" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S' "${deleted%%[.+Z]*}" +%s) \
       - $(date -d "$created" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S' "${created%%[.+Z]*}" +%s) ))
minutes=$(( (secs + 59) / 60 ))
hours=$(( (minutes + 59) / 60 )); [ "$hours" -ge 1 ] || hours=1

put nat-minutes "$minutes"
put nat-billed-hours "$hours"
