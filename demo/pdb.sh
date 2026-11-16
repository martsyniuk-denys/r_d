#!/usr/bin/env bash
#
#   npm run demo:pdb
#
# Two evictions back to back through the Eviction API — the path `kubectl drain`
# takes. (A plain `kubectl delete pod` never asks the PDB at all.) The codes are the
# HTTP status of each POST …/pods/<name>/eviction, read through `kubectl proxy`:
#
#   evict-1=201   the budget allowed one disruption, and spent it
#   evict-2=429   the evicted pod's replacement is still warming up; nothing left
#
#   healthy       status.currentHealthy of the PDB before the first eviction
#   minAvailable  status.desiredHealthy — what maxUnavailable: 1 means at this size
#
# The demo waits for the Deployment to recover afterwards, so it can be run again.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/k8s.sh"
cd "$ROOT"

replicas="$(kc -n "$NAMESPACE" get deploy "$DEPLOYMENT" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
if [ -z "$replicas" ]; then
  echo "demo:pdb: deployment $NAMESPACE/$DEPLOYMENT not found — npm run cluster:up && npm run up" >&2
  exit 1
fi
rev="$(current_rev)"

wait_settled() {
  local state i
  for i in $(seq 1 240); do
    state="$(kc -n "$NAMESPACE" get pods -l "app=$DEPLOYMENT" -o json | node scripts/lib/pods.mjs settled "$replicas" "$rev")"
    allowed="$(kc -n "$NAMESPACE" get pdb "$PDB" -o jsonpath='{.status.disruptionsAllowed}')"
    [ "$state" = "yes" ] && [ "${allowed:-0}" -ge 1 ] && return 0
    sleep 0.5
  done
  echo "demo:pdb: not settled: $state, disruptionsAllowed=$allowed" >&2
  return 1
}

PROXY_LOG="$(mktemp)"
PROXY_PID=""
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  rm -f "$PROXY_LOG"
}
trap cleanup EXIT

wait_settled

healthy="$(kc -n "$NAMESPACE" get pdb "$PDB" -o jsonpath='{.status.currentHealthy}')"
min_available="$(kc -n "$NAMESPACE" get pdb "$PDB" -o jsonpath='{.status.desiredHealthy}')"
allowed_before="$(kc -n "$NAMESPACE" get pdb "$PDB" -o jsonpath='{.status.disruptionsAllowed}')"

pods=()
while IFS= read -r name; do pods+=("$name"); done < <(
  kc -n "$NAMESPACE" get pods -l "app=$DEPLOYMENT" -o json | node scripts/lib/pods.mjs ready-names)

kc proxy --port=0 > "$PROXY_LOG" 2>&1 &
PROXY_PID=$!
disown "$PROXY_PID" 2>/dev/null || true
port=""
for i in $(seq 1 50); do
  port="$(sed -n 's/^Starting to serve on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$PROXY_LOG")"
  [ -n "$port" ] && break
  sleep 0.1
done
[ -n "$port" ] || { echo "demo:pdb: kubectl proxy did not start" >&2; cat "$PROXY_LOG" >&2; exit 1; }

evict() {
  curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$1\",\"namespace\":\"$NAMESPACE\"}}" \
    "http://127.0.0.1:$port/api/v1/namespaces/$NAMESPACE/pods/$1/eviction"
}

code1="$(evict "${pods[0]}")"
code2="$(evict "${pods[1]}")"
echo "# evicted ${pods[0]} -> $code1, then ${pods[1]} -> $code2" >&2

echo "replicas=$replicas"
echo "healthy=$healthy"
echo "minAvailable=$min_available"
echo "disruptions-allowed-before=$allowed_before"
echo "evict-1=$code1"
echo "evict-2=$code2"

echo "# waiting for the Deployment to recover" >&2
wait_settled
