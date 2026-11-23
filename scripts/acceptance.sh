#!/usr/bin/env bash
#
#   bash scripts/acceptance.sh <fresh clone> <out file>
#
# The acceptance run of README.md (evidence/acceptance.txt): every step of Quick start,
# the curl walk-through (taken from the README itself and run verbatim) and the checks
# of the grading table, each with its output and exit code, then a teardown. Run it on
# a clone, never on a working copy: it ends with `down -v`. The clone's directory name
# becomes the compose project, so name it anything but r_d to get volumes of its own.
# Stop any other copy of the stack first (fixed container names and ports).
set -u
cd "$1"
OUT=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
CURL_BLOCK=$(mktemp)
sed -n '/^B=http:\/\/localhost:3000/,/^```$/p' README.md | sed '$d' > "$CURL_BLOCK"
: > "$OUT"
FAILS=0

log() { printf '%s\n' "$@" >> "$OUT"; }
# compose progress lines and BuildKit steps are noise here; demo output is kept whole
quiet() { grep -vE '^ ?(Container|Network|Volume|Image) |^#[0-9]+ |^ ?[a-z-]+ (Built|Pulled|Building)|^\s*$|^ ?(\[\+\]|✔)'; }
run() { # run "<title>" "<command>" [expected: 0 | nonzero]
  local title=$1 cmd=$2 want=${3:-0}
  log "" "## $title" '```' "\$ $cmd"
  local start=$(date +%s)
  bash -c "$cmd" 2>&1 | quiet >> "$OUT"
  local code=${PIPESTATUS[0]}
  log '```' "exit=$code, ${want/0/expected 0}, $(( $(date +%s) - start )) s"
  if [ "$want" = 0 ]; then [ "$code" = 0 ] || FAILS=$((FAILS + 1)); else [ "$code" != 0 ] || FAILS=$((FAILS + 1)); fi
}
check() { # check "<what>" <condition...> — a verdict on output already in the log
  if "${@:2}"; then log "check: $1 — ok"; else log "check: $1 — FAILED"; FAILS=$((FAILS + 1)); fi
}

log "# Acceptance: README.md from a fresh clone" ""
log "- date: $(date -u +%FT%TZ)"
log "- commit: $(git rev-parse HEAD) ($(git rev-parse --abbrev-ref HEAD))"
log "- clone: tracked files only — no .env, no node_modules, no dist, nothing in secrets/ besides *.example ($(ls -a | grep -cE '^(\.env|node_modules|dist)$') of those present)"
log "- host: $(uname -sm), Docker $(docker version --format '{{.Server.Version}}'), Compose $(docker compose version --short)"
log "- before: image marketplace-api:compose present: $(docker images -q marketplace-api:compose | wc -l | tr -d ' '), volumes of this project: $(docker volume ls -q --filter label=com.docker.compose.project=$(basename "$PWD") | wc -l | tr -d ' ')"
log "- the dev stack of the working copy was stopped first (fixed container names and host ports, see README → Before you run it)"
origin=$(git remote get-url origin)
case $origin in
  http*|git@*) log "- cloned from: $origin" ;;
  *) log "- cloned from the local repository at the commit above (the branch was not on GitHub yet), so \`git clone https://github.com/…\` is the one README line not exercised" ;;
esac

# --- cold build -------------------------------------------------------------------------
run "Cold build of the image, no layer cache (not a README step: proves the Dockerfile builds from the clone alone)" \
  "docker compose build --no-cache keys"

# --- Quick start ------------------------------------------------------------------------
run "Quick start: one command" "docker compose up -d --wait"
run "state after up" "docker compose ps -a --format '{{.Service}}: {{.Status}}'"
run "Quick start: the contour" "docker compose run --rm demo demo/contour.mjs"
run "Quick start: the webhook" "docker compose run --rm demo demo/webhook.mjs"

# --- The contour by hand: the README block, verbatim ---------------------------------------
log "" "## The contour by hand — README.md 'By hand, with curl', run verbatim ($(wc -l < "$CURL_BLOCK" | tr -d ' ') lines)"
log '```'
bash -c "$(cat "$CURL_BLOCK")"'
echo "$ORDER" > .order-id; echo "$TOKEN" > .token' 2>&1 | quiet | tee .by-hand >> "$OUT"
log '```'
ORDER=$(cat .order-id); export ORDER TOKEN=$(cat .token)
check "1. checkout answered pending" grep -q '"status":"pending"' .by-hand
check "2. the separate read saw confirmed" grep -q '"status":"confirmed"' .by-hand
check "3. webhook applied, then duplicate" grep -q '"verdict":"applied"' .by-hand
check "3. webhook applied, then duplicate" grep -q '"verdict":"duplicate"' .by-hand
check "4. history has 3 steps ending in paid" grep -q '"changed_by":"payment-webhook"' .by-hand
check "5. no key → 400 problem+json" grep -q '"status":400' .by-hand
check "6. SSE replayed 3 events" test "$(grep -c '^event: order.status' .by-hand)" = 3

# --- Observability ------------------------------------------------------------------------
run "Observability: the obs profile" "docker compose --profile obs up -d --wait"
run "Observability: one trace across three processes" "docker compose run --rm demo demo/contour-trace.mjs | tee .trace"
export TRACE=$(sed -n 's/^checkout_trace=//p' .trace)
run "11.7 that trace_id in the logs of all three processes (lines per process)" \
  'docker compose logs --no-log-prefix api relay consumer | grep "$TRACE" | node -e '"'"'const seen={};require("readline").createInterface({input:process.stdin}).on("line",l=>{const j=JSON.parse(l);const k=j.service??(j.kind==="published"?"marketplace-relay":"marketplace-consumer");seen[k]=(seen[k]??0)+1}).on("close",()=>{console.log(seen);process.exit(Object.keys(seen).length===3?0:1)})'"'"
run "11.7 Prometheus scrapes api, relay, consumer" \
  "curl -s 'http://127.0.0.1:22901/api/v1/targets?state=active' | node -pe 'JSON.parse(require(\"fs\").readFileSync(0)).data.activeTargets.map(t=>t.labels.job+\"=\"+t.health).join(\" \")'"
cat > .transitions.sh <<'SH'
relay() { docker compose run --rm -T --entrypoint wget demo -qO- http://relay:9464/metrics 2>/dev/null | awk '/^order_status_transitions_total/ {n += $2} END {print n + 0}'; }
prom() { curl -s 'http://127.0.0.1:22901/api/v1/query?query=sum(order_status_transitions_total)' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.result[0]?.value[1] ?? 0'; }
want=$(relay)
for i in $(seq 20); do got=$(prom); [ "$got" = "$want" ] && break; sleep 1; done
curl -s 'http://127.0.0.1:22901/api/v1/query?query=order_status_transitions_total' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.result.map(r=>r.metric.from+"→"+r.metric.to+"="+r.value[1]).join(" ")'
echo "relay /metrics: $want, Prometheus: $got"
[ "$got" = "$want" ] && [ "$want" -gt 0 ]
SH
run "11.7 transitions: the relay's counter, and Prometheus agreeing with it (waits up to 20 s for a scrape)" "bash .transitions.sh"
run "Grafana: the dashboard is provisioned from the file" \
  "curl -s -u admin:\$(cat secrets/grafana_admin_password.example) http://127.0.0.1:22903/api/dashboards/uid/marketplace-red | node -pe 'const d=JSON.parse(require(\"fs\").readFileSync(0)).dashboard; const all=d.panels.flatMap(p=>[p,...(p.panels??[])]); d.title+\": \"+all.filter(p=>p.type!==\"row\").length+\" panels, rows: \"+all.filter(p=>p.type===\"row\").map(p=>p.title).join(\", \")'"

# --- 11.1 / 11.4 / 11.7 ----------------------------------------------------------------------
run "11.7 probes" "curl -s -w ' HTTP %{http_code}\n' localhost:3000/healthz; curl -s -w ' HTTP %{http_code}\n' localhost:3000/readyz"
run "11.1 fail-fast: the broken variable is named, the value is not, exit 1" \
  "docker compose run --rm --no-deps -e PAYMENT_WEBHOOK_SECRET_FILE= -e PAYMENT_WEBHOOK_SECRET=short api" nonzero
run "11.4 the API container's environment: paths and password-less URLs, no secret value" \
  "docker inspect \$(docker compose ps -a -q api) --format '{{range .Config.Env}}{{println .}}{{end}}' | sort"
run "11.7 SIGTERM: readiness red at once, liveness green through the drain, exit 0" \
  "docker compose kill -s SIGTERM api >/dev/null 2>&1
for i in 1 2 3; do echo \"readyz \$(curl -s -o /dev/null -w '%{http_code}' localhost:3000/readyz)  healthz \$(curl -s -o /dev/null -w '%{http_code}' localhost:3000/healthz)\"; sleep 1; done
sleep 6; docker inspect \$(docker compose ps -a -q api) --format 'api: {{.State.Status}}, exit code {{.State.ExitCode}}'"
run "api back" "docker compose up -d --wait api"

# --- 11.6 restart keeps data and keys --------------------------------------------------------
run "11.6 restart (README → Restart and teardown)" "docker compose down && docker compose up -d --wait"
run "11.6 after the restart: the token issued before it still works, the order is still paid" \
  'curl -s localhost:3000/orders/$ORDER -H "authorization: Bearer $TOKEN"; echo'
check "the order read after the restart is paid" bash -c "tail -4 '$OUT' | grep -q '\"status\":\"paid\"'"

# --- Teardown ------------------------------------------------------------------------------
run "Teardown" "docker compose --profile obs --profile demo down -v"
run "nothing left of this project: containers, volumes" \
  "docker compose ps -a -q | wc -l | tr -d ' '; docker volume ls -q --filter label=com.docker.compose.project=$(basename "$PWD") | wc -l | tr -d ' '"
rm -f .token .order-id .trace .by-hand .transitions.sh "$CURL_BLOCK"

log "" "## Verdict" "" "failed steps and checks: $FAILS"
echo "failed: $FAILS"
