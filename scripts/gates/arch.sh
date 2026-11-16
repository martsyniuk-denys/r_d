#!/usr/bin/env bash
#
#   bash scripts/gates/arch.sh [extra-dir ...]
#
# Step 3 of the gates: dependency-cruiser with the rules of .dependency-cruiser.cjs —
# the README's "modules do not reach into each other" as a check that can say no.
# An extra directory (demo:gates passes test/gates/arch) is cruised with src/.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

npx --no-install depcruise --config .dependency-cruiser.cjs --output-type err src "$@"
