#!/usr/bin/env bash
#
#   npm run demo:rollout                    # PROFILE=safe
#   PROFILE=broken npm run demo:rollout     # no probes, maxUnavailable 1, no drain
#
# A rolling update under load, measured. The load generator keeps requests in flight
# against the NodePort the whole time and writes the code of every response to a
# file; requests/ok/failed are counted from that file, nothing else.
#
#   1. the Deployment is brought to PROFILE at its current revision and left to settle
#   2. load starts, 3 s of baseline
#   3. `pulumi up` with APP_REV+1 changes the pod template → a rollout
#   4. load runs until only new pods are left, all ready, plus 2 s
#   5. the file is counted; a broken profile is put back to safe on the way out
#
#   rollout-seconds   from the creation of the new ReplicaSet to the moment the last
#                     old pod is gone (drain included) — Kubernetes' time, not Pulumi's

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/k8s.sh"
cd "$ROOT"

PROFILE="${PROFILE:-safe}"
CONCURRENCY="${LOAD_CONCURRENCY:-16}"
KEEPALIVE="${LOAD_KEEPALIVE:-1}"
# without keep-alive every request is a new host port; see scripts/load.mjs
RATE="${LOAD_RATE:-$([ "$KEEPALIVE" = "0" ] && echo 300 || echo 0)}"
MIN_REQUESTS="${MIN_REQUESTS:-5000}"
# A real route of the API, through Nest and the pool to Postgres — not a probe: a
# draining pod still answers it, and that is what the drain is for.
URL="http://127.0.0.1:$NODE_PORT${LOAD_PATH:-/products}"

case "$PROFILE" in safe|broken) ;; *) echo "PROFILE must be safe or broken" >&2; exit 2 ;; esac

from_rev="$(current_rev)"
if [ -z "$from_rev" ]; then
  echo "demo:rollout: deployment $NAMESPACE/$DEPLOYMENT not found — npm run cluster:up && npm run up" >&2
  exit 1
fi
replicas="$(kc -n "$NAMESPACE" get deploy "$DEPLOYMENT" -o jsonpath='{.spec.replicas}')"
case "$from_rev" in *[!0-9]*) new_rev="$(date +%s)" ;; *) new_rev=$((from_rev + 1)) ;; esac

CODES="$(mktemp)"
PULUMI_LOG="$(mktemp)"
LOAD_PID=""
final_rev="$from_rev"

deploy() {
  if ! ROLLOUT_PROFILE="$1" APP_REV="$2" bash scripts/pulumi.sh up > "$PULUMI_LOG" 2>&1; then
    cat "$PULUMI_LOG" >&2
    return 1
  fi
}

wait_settled() {
  local rev="$1" state i
  for i in $(seq 1 240); do
    state="$(kc -n "$NAMESPACE" get pods -l "app=$DEPLOYMENT" -o json | node scripts/lib/pods.mjs settled "$replicas" "$rev")"
    [ "$state" = "yes" ] && return 0
    sleep 0.5
  done
  echo "demo:rollout: pods did not settle on rev $rev: $state" >&2
  return 1
}

cleanup() {
  [ -n "$LOAD_PID" ] && kill -TERM "$LOAD_PID" 2>/dev/null || true
  if [ "$PROFILE" != "safe" ]; then
    echo "# restoring the safe profile at rev $final_rev" >&2
    deploy safe "$final_rev" && wait_settled "$final_rev" || true
  fi
  rm -f "$CODES" "$PULUMI_LOG"
}
trap cleanup EXIT

echo "# profile $PROFILE, rev $from_rev -> $new_rev, $replicas replicas, $CONCURRENCY in flight, keep-alive $KEEPALIVE, rate ${RATE}/s (0 = unlimited)" >&2
deploy "$PROFILE" "$from_rev"
wait_settled "$from_rev"

node scripts/load.mjs --url "$URL" --out "$CODES" --concurrency "$CONCURRENCY" --keepalive "$KEEPALIVE" --rate "$RATE" &
LOAD_PID=$!
sleep 3

echo "# pulumi up: rev $new_rev" >&2
deploy "$PROFILE" "$new_rev"
final_rev="$new_rev"
kc -n "$NAMESPACE" rollout status "deploy/$DEPLOYMENT" --timeout=180s >&2
wait_settled "$new_rev"
settled_at="$(date +%s)"
sleep 2

kill -TERM "$LOAD_PID"
wait "$LOAD_PID" || true
LOAD_PID=""

created_at="$(kc -n "$NAMESPACE" get rs -l "app=$DEPLOYMENT" -o json | node scripts/lib/pods.mjs rs-created "$new_rev")"
if [ -z "$created_at" ]; then
  echo "demo:rollout: no ReplicaSet carries rev $new_rev — rollout-seconds cannot be measured" >&2
  exit 1
fi

requests=$(wc -l < "$CODES" | tr -d ' ')
ok=$(grep -cx '200' "$CODES" || true)
failed=$((requests - ok))

sort "$CODES" | uniq -c | while read -r n code; do echo "# code $code: $n"; done

echo "profile=$PROFILE"
echo "keepalive=$KEEPALIVE"
echo "rev-from=$from_rev"
echo "rev-to=$new_rev"
echo "requests=$requests"
echo "ok=$ok"
echo "failed=$failed"
echo "rollout-seconds=$((settled_at - created_at))"

[ "$failed" -eq 0 ] && [ "$requests" -ge "$MIN_REQUESTS" ]
