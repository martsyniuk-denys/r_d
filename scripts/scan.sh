#!/usr/bin/env bash
#
#   SCAN_MAX=10 npm run scan
#
# Scans $IMAGE with Trivy, counts the findings of the report and compares the count
# with SCAN_MAX. The verdict is computed from the report: found <= max-allowed is a
# pass (exit 0), anything else a fail (exit 1). A scan that could not run is
# neither (exit 2) — an empty report is not a clean image.
#
#   SCAN_MAX       highest number of findings that still passes   (default 25)
#   SCAN_SEVERITY  severities counted                             (default CRITICAL,HIGH)
#   SCAN_FIXABLE   1 = only findings with a fixed version         (default 1)
#   SCAN_IMAGE     image to scan                                  (default $IMAGE)
#
# Uses a local `trivy` if there is one, otherwise the aquasec/trivy image.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/k8s.sh"

TARGET="${SCAN_IMAGE:-$IMAGE}"
SEVERITY="$(printf '%s' "${SCAN_SEVERITY:-CRITICAL,HIGH}" | tr -d ' ' | tr '[:lower:]' '[:upper:]')"
MAX="${SCAN_MAX:-25}"
FIXABLE="${SCAN_FIXABLE:-1}"
TRIVY_IMAGE="aquasec/trivy:0.76.2"

if ! [[ "$MAX" =~ ^-?[0-9]+$ ]]; then
  echo "scan: SCAN_MAX must be an integer, got '$MAX'" >&2
  exit 2
fi

if ! docker image inspect "$TARGET" >/dev/null 2>&1; then
  echo "scan: image $TARGET not found — npm run image:build first" >&2
  echo "gate=error"
  exit 2
fi

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT

ARGS=(image --quiet --format json --severity "$SEVERITY" --scanners vuln)
[ "$FIXABLE" = "1" ] && ARGS+=(--ignore-unfixed)

if command -v trivy >/dev/null 2>&1; then
  trivy "${ARGS[@]}" "$TARGET" > "$REPORT" || { echo "gate=error"; exit 2; }
else
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}:/root/.cache/trivy" \
    "$TRIVY_IMAGE" "${ARGS[@]}" "$TARGET" > "$REPORT" || { echo "gate=error"; exit 2; }
fi

# Counted from the report, per severity, with the same filter the scanner was given.
node - "$REPORT" "$SEVERITY" "$FIXABLE" "$MAX" "$TARGET" <<'NODE'
const [report, severityList, fixable, maxRaw, image] = process.argv.slice(2);
const data = JSON.parse(require('node:fs').readFileSync(report, 'utf8'));
const wanted = new Set(severityList.split(',').map((s) => s.trim().toUpperCase()));
const findings = (data.Results ?? [])
  .flatMap((r) => r.Vulnerabilities ?? [])
  .filter((v) => wanted.has(v.Severity))
  .filter((v) => fixable !== '1' || Boolean(v.FixedVersion));
const bySeverity = {};
for (const s of wanted) bySeverity[s] = 0;
for (const v of findings) bySeverity[v.Severity] += 1;
const found = findings.length;
const max = Number(maxRaw);
const pass = found <= max;
for (const v of findings) console.log(`# ${v.Severity} ${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} -> ${v.FixedVersion || '-'}`);
console.log(`image=${image}`);
console.log(`severity=${[...wanted].join(',')}`);
console.log(`fixable-only=${fixable === '1' ? 1 : 0}`);
for (const [s, n] of Object.entries(bySeverity)) console.log(`found-${s.toLowerCase()}=${n}`);
console.log(`found=${found}`);
console.log(`max-allowed=${max}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
process.exit(pass ? 0 : 1);
NODE
