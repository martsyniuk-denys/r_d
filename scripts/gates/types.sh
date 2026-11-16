#!/usr/bin/env bash
#
#   bash scripts/gates/types.sh [extra.ts ...]
#
# Step 1 of the gates: tsc --noEmit over src/ and the linter (eslint.config.mjs)
# over the same files. Extra files join both checks — that is how demo:gates feeds
# the broken fixture in, through the very same commands CI runs. Exit 0 only when
# both are clean.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TSCONFIG="tsconfig.json"
if [ "$#" -gt 0 ]; then
  # rootDir widens to the repo so a file outside src/ is checked, not refused (TS6059).
  TSCONFIG="$(mktemp "$ROOT/.tsconfig.gate.XXXXXX")"
  trap 'rm -f "$TSCONFIG"' EXIT
  node -e '
    const [out, ...extra] = process.argv.slice(1);
    require("node:fs").writeFileSync(out, JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["src/**/*", ...extra],
    }));' "$TSCONFIG" "$@"
fi

npx --no-install tsc --noEmit -p "$TSCONFIG"
tsc=$?
npx --no-install eslint --max-warnings 0 src "$@"
lint=$?

echo "tsc-exit=$tsc"
echo "lint-exit=$lint"
[ "$tsc" -eq 0 ] && [ "$lint" -eq 0 ]
