#!/usr/bin/env bash
#
#   bash scripts/aws-checks.sh [stack ...]          # default: demo base
#   EVIDENCE_FILE=evidence/demos.txt bash scripts/aws-checks.sh   # also record the six
#
# The six emptiness checks of the teardown contract, run after `pulumi destroy` and
# `pulumi stack export`, before any `stack rm`. Two sources of truth side by side:
# the Pulumi state (what the program believes it owns) and the AWS API asked by tag
# and by type (what is actually there). A difference between the two is the tail.
#
# Every API check runs in the stack's region AND in us-east-1, and the contract line
# is the sum: a stack in the wrong region gives an honest-looking zero elsewhere.
# Each key is printed once, as the last word — the grader takes the last match.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true
[ "$#" -gt 0 ] || set -- demo base

# The region comes from the stack's config, never from ~/.aws/config.
R="$(cd "$ROOT/infra/$1" && pulumi config get aws:region --stack "$1")"
REGIONS="$R"; [ "$R" = us-east-1 ] || REGIONS="$R us-east-1"

# 1. state-resources-left — aws:* resources still in each stack's state.
state=0
for s in "$@"; do
  n="$(cd "$ROOT/infra/$s" && pulumi stack export --stack "$s" \
        | jq '[.deployment.resources[]? | select(.type | startswith("aws:"))] | length')"
  echo "  state[$s]=$n"
  state=$((state + n))
done

# An API this LocalStack edition does not emulate answers 501 for every call. Such a
# service cannot hold a resource, so its count is 0 — said out loud, not swallowed.
# Any other error stops the job: an unreadable check is not a zero.
count() { # $1 = label, rest = aws command → prints a number
  local label="$1"; shift
  local out
  if out="$("$@" --output text 2>&1)"; then echo "$out"; return; fi
  if grep -qE 'not included in your current license plan|not included within your LocalStack license' <<<"$out"; then
    echo "  $label: 501, API not emulated by this LocalStack edition — nothing can exist there" >&2
    echo 0; return
  fi
  echo "$out" >&2; exit 1
}

tagged=0; rds=0; alb=0; nat=0; eip=0
for r in $REGIONS; do
  # The contract's query, verbatim. Stack=demo: base is allowed to outlive the session,
  # and a live base must not turn this into a non-zero. :natgateway/ is excluded because
  # a deleted NAT stays visible to the tagging API for about an hour; nat-left counts it.
  t="$(count "tagged@$r" aws resourcegroupstaggingapi get-resources --region "$r" \
        --tag-filters Key=Project,Values=nodejs-pro-hw31 Key=Stack,Values=demo \
        --query "length(ResourceTagMappingList[?!contains(ResourceARN, ':natgateway/')])")"
  d="$(count "rds@$r" aws rds describe-db-instances --region "$r" --query 'length(DBInstances)')"
  l="$(count "alb@$r" aws elbv2 describe-load-balancers --region "$r" --query 'length(LoadBalancers)')"
  # A NAT in `pending` is already billed and becomes `available` after the check.
  n="$(count "nat@$r" aws ec2 describe-nat-gateways --region "$r" --filter Name=state,Values=pending,available \
        --query 'length(NatGateways)')"
  e="$(count "eip@$r" aws ec2 describe-addresses --region "$r" --query 'length(Addresses)')"
  echo "  $r: tagged=$t rds=$d alb=$l nat=$n eip=$e"
  tagged=$((tagged + t)); rds=$((rds + d)); alb=$((alb + l)); nat=$((nat + n)); eip=$((eip + e))
done

contract="state-resources-left=$state
tagged-resources-left=$tagged
rds-left=$rds
alb-left=$alb
nat-left=$nat
eip-left=$eip"
echo "$contract"

# Locally the same six lines go into an evidence file, replacing older values of the
# same keys. That file is written by this machine — a floor, not a proof; the proof
# is the teardown run in GitHub Actions.
if [ -n "${EVIDENCE_FILE:-}" ]; then
  touch "$EVIDENCE_FILE"
  grep -vE '^(state-resources|tagged-resources|rds|alb|nat|eip)-left=' "$EVIDENCE_FILE" > "$EVIDENCE_FILE.tmp" || true
  echo "$contract" >> "$EVIDENCE_FILE.tmp"
  mv "$EVIDENCE_FILE.tmp" "$EVIDENCE_FILE"
fi

[ $((state + tagged + rds + alb + nat + eip)) -eq 0 ] || { echo "teardown: NOT empty" >&2; exit 1; }
echo "teardown: empty in $REGIONS"
