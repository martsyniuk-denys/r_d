#!/usr/bin/env bash
#
#   npm run demo:gates
#
# The four steps of the quality gates, each run twice through the same command CI
# runs: on the correct input (expected exit 0) and on a deliberately broken one
# (expected non-zero). A step that cannot say "no" on its broken input is a report,
# not a gate. Prints <step>-ok=<exit> and <step>-broken=<exit>; the tools' own output
# goes to stderr.
#
#   types     tsc --noEmit + eslint      broken: test/gates/types/broken.ts (a typo in a type, ==)
#   contract  oasdiff breaking           broken: the spec with GET /products/{productId} renamed away
#   arch      dependency-cruiser         broken: test/gates/arch (catalog imports the order flow)
#   scan      npm run scan (HW #28)      broken: SCAN_MAX=-1, which no image passes; ok: SCAN_MAX=99999
#
# Needs no cluster, no GitHub and no secret store. Needs Docker for the scanner (and
# for oasdiff when there is no local binary); the image is built once if missing.

set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/k8s.sh"
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# run <key> <command...>: the command's output to stderr, its exit code to stdout
run() {
  local key="$1"; shift
  echo "# --- $key: $*" >&2
  "$@" >&2 2>&1
  local code=$?
  echo "$key=$code"
}

run types-ok      bash scripts/gates/types.sh
run types-broken  bash scripts/gates/types.sh test/gates/types/broken.ts

cp openapi/openapi.yaml "$WORK/base.yaml"
# A real breaking change: the path a client already calls disappears (renamed).
sed -E 's#^  /products/\{productId\}:$#  /items/{productId}:#' openapi/openapi.yaml > "$WORK/broken.yaml"
if cmp -s "$WORK/base.yaml" "$WORK/broken.yaml"; then
  echo "demo:gates: the broken spec came out identical — the sed no longer matches openapi.yaml" >&2
  exit 1
fi
run contract-ok     bash scripts/gates/contract.sh "$WORK/base.yaml" openapi/openapi.yaml
run contract-broken bash scripts/gates/contract.sh "$WORK/base.yaml" "$WORK/broken.yaml"

run arch-ok     bash scripts/gates/arch.sh
run arch-broken bash scripts/gates/arch.sh test/gates/arch

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "# $IMAGE is not built — building it once for the scanner" >&2
  # no private registry here: a random decoy is the build-stage token (HW #28)
  [ -s .npm_token ] || openssl rand -hex 16 > .npm_token
  bash scripts/image-build.sh >&2 || { echo "demo:gates: image build failed" >&2; exit 1; }
fi
run scan-ok     env SCAN_MAX=99999 bash scripts/scan.sh
run scan-broken env SCAN_MAX=-1 bash scripts/scan.sh
