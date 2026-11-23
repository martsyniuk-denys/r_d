#!/usr/bin/env bash
#
#   GH_TOKEN=… REPO=owner/repo SHA=<main commit> [PR=<number>] bash scripts/ci/promote.sh <dir>
#
# deploy.yml does not build. It finds the digest a green `pr` run already built,
# scanned, deployed and rolled out, and hands that on — the bytes that reach main's
# deploy are the bytes the PR checked, not a second build of the same source.
#
#   1. the PR: PR when given, else the merged PR that SHA belongs to
#   2. its green `pr` runs (event pull_request, conclusion success) on the PR's head
#   3. the first of them whose tested commit (the tag of its image-ref — the merge
#      commit GitHub built for the PR) has the same tree as SHA. A run that tested the
#      PR against an older base checked different code, and does not count.
#   4. its pipeline-evidence: built-digest, and deployed-digest equal to it
#
# Writes repository, image-ref, digest, scan-exit to $GITHUB_OUTPUT (when set) and
# the promote-* lines to <dir>/promote.txt. Exit 1 when no run qualifies: then the PR
# has to be brought up to date with its base and go green again before main deploys.

set -euo pipefail

DIR="${1:?usage: $0 <dir>}"
: "${REPO:?REPO is not set}" "${SHA:?SHA is not set}"
mkdir -p "$DIR"

tree() { gh api "repos/$REPO/git/commits/$1" --jq .tree.sha 2>/dev/null || true; }
value() { awk -F= -v k="$1" '$1==k{v=substr($0, length(k)+2)} END{print v}' "$2"; }

pr="${PR:-}"
if [ -z "$pr" ]; then
  pr="$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '[.[] | select(.merged_at != null)][0].number // empty')"
fi
if [ -z "$pr" ]; then
  echo "promote: $SHA belongs to no merged PR — nothing was verified, nothing to promote" >&2
  exit 1
fi
head="$(gh api "repos/$REPO/pulls/$pr" --jq .head.sha)"
want="$(tree "$SHA")"
echo "promote: PR #$pr, head $head; $SHA has tree $want" >&2

for run in $(gh api "repos/$REPO/actions/workflows/pr.yml/runs?event=pull_request&status=success&head_sha=$head&per_page=30" \
  --jq '.workflow_runs[].id'); do
  got="$DIR/run-$run"
  if ! gh run download "$run" --repo "$REPO" --name pipeline-evidence --dir "$got" >/dev/null 2>&1; then
    echo "promote: run $run — no pipeline-evidence (expired?)" >&2
    continue
  fi
  ev="$got/evidence.txt"
  ref="$(value image-ref "$ev")"
  built="$(value built-digest "$ev")"
  deployed="$(value deployed-digest "$ev")"
  tested="${ref##*:}"
  if [ -z "$built" ] || [ "$deployed" != "$built" ]; then
    echo "promote: run $run — built=${built:-none} deployed=${deployed:-none}, skipped" >&2
    continue
  fi
  if [ "$(tree "$tested")" != "$want" ]; then
    echo "promote: run $run tested $tested, whose tree is not $SHA's — skipped" >&2
    continue
  fi

  {
    echo "promote-pr=$pr"
    echo "promote-from-run=$run"
    echo "promote-tested-sha=$tested"
    echo "promote-tree=$want"
    echo "promote-digest=$built"
  } | tee "$DIR/promote.txt"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "repository=${ref%:*}"
      echo "image-ref=$ref"
      echo "digest=$built"
      echo "scan-exit=$(value gate-scan-exit "$ev")"
    } >> "$GITHUB_OUTPUT"
  fi
  exit 0
done

echo "promote: no green pr run of PR #$pr tested $SHA's tree — update the PR with its base and let pr.yml go green" >&2
exit 1
