#!/usr/bin/env bash
#
#   bash scripts/ci/evidence.sh deploy <dir>   # in the deploy job: <dir>/deploy-evidence.txt
#   bash scripts/ci/evidence.sh final <dir>    # in the evidence job: <dir>/evidence.txt
#
# Assembles the key=value lines of the pipeline-evidence artifact from what the
# steps wrote — the gate's output, the manifest check, demo:rollout's raw output and
# build.log. Nothing here is a constant: a missing input leaves its key out, and the
# grader's check of that key fails, which is the point.
#
# final reads RUN_ID, HEAD_SHA, IMAGE_REF, BUILT_DIGEST and SCAN_EXIT from the env.
# A run that promotes instead of building (deploy.yml) leaves promote.txt and no
# build.log: build-invocations is then 0, and the promote-* lines say where from.

set -euo pipefail

MODE="${1:?usage: $0 deploy|final <dir>}"
DIR="${2:?usage: $0 deploy|final <dir>}"

# value <key> <file>: the last key=value line of a file, empty when absent
value() { [ -f "$2" ] && awk -F= -v k="$1" '$1==k{v=substr($0, length(k)+2)} END{print v}' "$2" || true; }

line() { [ -n "$2" ] && echo "$1=$2" || true; }

case "$MODE" in
  deploy)
    {
      # oidc only when the gate let the token through: a denied token is no credential
      line creds-source "$( [ "$(value policy-allow "$DIR/oidc.txt")" = 1 ] && echo oidc )"
      line oidc-iss "$(value iss "$DIR/oidc.txt")"
      line oidc-aud "$(value aud "$DIR/oidc.txt")"
      line oidc-sub "$(value sub "$DIR/oidc.txt")"
      line oidc-sig-verified "$(value sig-verified "$DIR/oidc.txt")"
      line oidc-policy-allow "$(value policy-allow "$DIR/oidc.txt")"
      line deployed-digest "$(value deployed-digest "$DIR/manifest.txt")"
      line secret-in-manifest "$(value secret-in-manifest "$DIR/manifest.txt")"
      line cost-base-source "$(value base-source "$DIR/cost.txt")"
      line cost-base-usd "$(value base-usd "$DIR/cost.txt")"
      line cost-plan-usd "$(value plan-usd "$DIR/cost.txt")"
      line cost-budget-usd "$(value budget-usd "$DIR/cost.txt")"
      line cost-gate "$(value gate "$DIR/cost.txt")"
      line rollout-profile "$(value profile "$DIR/rollout.txt")"
      line rollout-requests "$(value requests "$DIR/rollout.txt")"
      line rollout-ok "$(value ok "$DIR/rollout.txt")"
      line rollout-failed "$(value failed "$DIR/rollout.txt")"
      line rollout-seconds "$(value rollout-seconds "$DIR/rollout.txt")"
    } > "$DIR/deploy-evidence.txt"
    cat "$DIR/deploy-evidence.txt"
    ;;
  final)
    {
      line run-id "${RUN_ID:-}"
      line head-sha "${HEAD_SHA:-}"
      line image-ref "${IMAGE_REF:-}"
      line built-digest "${BUILT_DIGEST:-}"
      line build-invocations "$(
        if [ -f "$DIR/build.log" ]; then wc -l < "$DIR/build.log" | tr -d ' '
        elif [ -f "$DIR/promote.txt" ]; then echo 0
        fi )"
      line gate-scan-exit "${SCAN_EXIT:-}"
      if [ -f "$DIR/promote.txt" ]; then cat "$DIR/promote.txt"; fi
      if [ -f "$DIR/deploy-evidence.txt" ]; then cat "$DIR/deploy-evidence.txt"; fi
    } > "$DIR/evidence.txt"
    rm -f "$DIR/deploy-evidence.txt" "$DIR/promote.txt"
    cat "$DIR/evidence.txt"
    ;;
  *)
    echo "usage: $0 deploy|final <dir>" >&2
    exit 2
    ;;
esac
