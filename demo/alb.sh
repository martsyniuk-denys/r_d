#!/usr/bin/env bash
#
#   npm run demo:alb
#
# The ALB answers, and its target is in rotation. Writes to evidence/demos.txt:
#
#   alb-dns       the balancer's public name (no domain of our own: Route 53 zones bill monthly)
#   http-code     status of GET / through the ALB
#   target-state  TargetHealth.State of the Lambda target — the line that matters more:
#                 an unhealthy target turns the same request into a 503
#
# A new ALB needs a minute or two before its name resolves and the first health
# check passes, so both are polled rather than asked once.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/aws.sh"
refuse_emulator demo:alb

R="$(demo_region)"; DNS="$(demo_output albDns)"; TG="$(demo_output targetGroupArn)"

state=unknown
for i in $(seq 1 60); do
  state="$(aws elbv2 describe-target-health --region "$R" --target-group-arn "$TG" \
            --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)"
  [ "$state" = healthy ] && break
  echo "  target: $state"; sleep 10
done

code=000
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$DNS/" || true)"
  [ "$code" = 200 ] && break
  echo "  GET http://$DNS/ → $code"; sleep 5
done

put alb-dns "$DNS"
put http-code "$code"
put target-state "$state"
