#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh ci bash scripts/ci/base-plan.sh <base-sha> <base-plan.json>
#
# The plan the cost gate measures the change against. In CI the stack is created fresh
# in every run, so the oldState of plan.json is always empty and "base" would be $0 —
# the gate would compare the whole bill with the $10 delta. Here the base branch's own
# Pulumi program is previewed instead, into an empty stack of its own: what it leads
# to is what the base costs.
#
# The base commit is checked out as a separate worktree; its infra/ is run through
# this branch's scripts/pulumi.sh (ROOT points at the worktree), with its own file
# backend, so its stack never meets the one `pulumi up` is about to write.
# A base without a Pulumi program deploys nothing: its plan is empty, base-usd = 0.

set -euo pipefail

BASE="${1:?usage: $0 <base-sha> <base-plan.json>}"
OUT="${2:?usage: $0 <base-sha> <base-plan.json>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TREE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/base-tree"

git -C "$HERE" fetch --quiet --no-tags --depth=1 origin "$BASE" >&2
rm -rf "$TREE"
git -C "$HERE" worktree add --quiet --detach "$TREE" "$BASE" >&2
trap 'git -C "$HERE" worktree remove --force "$TREE" >/dev/null 2>&1 || true' EXIT

if [ ! -f "$TREE/infra/Pulumi.yaml" ]; then
  echo "base-plan: $BASE has no infra/Pulumi.yaml — an empty plan" >&2
  echo '{"steps":[]}' > "$OUT"
  exit 0
fi

ROOT="$TREE" PULUMI_BACKEND_URL="file://$TREE/.pulumi" bash "$HERE/scripts/pulumi.sh" plan > "$OUT"
echo "base-plan: $BASE → $(node -e 'console.log((require(process.argv[1]).steps ?? []).length)' "$(realpath "$OUT")") steps" >&2
