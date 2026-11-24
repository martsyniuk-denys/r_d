#!/usr/bin/env bash
#
#   bash scripts/gates/contract.sh <base-spec> <revision-spec>
#
# Step 2 of the gates: oasdiff, breaking changes only. Fails (exit 1) on any change
# of level ERR — what breaks a client that already lives on the base version, whether
# or not a Pact consumer of it is known. The base in CI is the spec of the PR's base
# branch; demo:gates compares the spec with itself and with a broken copy.
#
# A local `oasdiff` if there is one, otherwise the image, pinned by digest.

set -euo pipefail

BASE="${1:?usage: $0 <base-spec> <revision-spec>}"
REVISION="${2:?usage: $0 <base-spec> <revision-spec>}"
OASDIFF_IMAGE="tufin/oasdiff:v1.34.1@sha256:67a23cfea7d251e2ae34ee703ac8733c5d96bc2e7b90fd0f4d475ec99367b85f"

for f in "$BASE" "$REVISION"; do
  [ -s "$f" ] || { echo "contract: $f is missing or empty" >&2; exit 2; }
done

if command -v oasdiff >/dev/null 2>&1; then
  oasdiff breaking "$BASE" "$REVISION" --fail-on ERR
else
  base_abs="$(cd "$(dirname "$BASE")" && pwd)/$(basename "$BASE")"
  rev_abs="$(cd "$(dirname "$REVISION")" && pwd)/$(basename "$REVISION")"
  docker run --rm \
    -v "$base_abs:/specs/base.yaml:ro" -v "$rev_abs:/specs/revision.yaml:ro" \
    "$OASDIFF_IMAGE" breaking /specs/base.yaml /specs/revision.yaml --fail-on ERR
fi
