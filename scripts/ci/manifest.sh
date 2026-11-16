#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh ci bash scripts/ci/manifest.sh <deployment.json> <expected-digest>
#
# Reads the Deployment that went into the cluster (kubectl get deploy -o json) and
# prints two numbers the pipeline cannot take on trust:
#
#   deployed-digest      the sha256 of the image the pod template names — must be the
#                        digest the build job produced, not a tag that points to it
#   secret-in-manifest   how many times the app's secret value occurs in the manifest,
#                        as is or base64-encoded. Counted here, where the value is
#                        known (from the store); the grader only ever sees the number.
#
# Exit 1 when the digest differs or the secret is in the manifest.

set -euo pipefail

MANIFEST="${1:?usage: $0 <deployment.json> <expected-digest>}"
EXPECTED="${2:?usage: $0 <deployment.json> <expected-digest>}"
: "${DB_PASSWORD:?DB_PASSWORD is not set — run through scripts/with-secrets.sh}"

image="$(node -e 'console.log(require(process.argv[1]).spec.template.spec.containers[0].image)' "$(realpath "$MANIFEST")")"
case "$image" in
  *@sha256:*) deployed="${image##*@}" ;;
  *)          deployed="" ;;
esac

# grep -o: every occurrence, not every line; no match is a count of 0, not an error
count() { { grep -oF -- "$1" "$MANIFEST" || true; } | wc -l | tr -d ' '; }
plain=$(count "$DB_PASSWORD")
encoded=$(count "$(printf '%s' "$DB_PASSWORD" | base64 | tr -d '\n')")

echo "deployed-image=${image%@*}"
echo "deployed-digest=${deployed:-none}"
echo "secret-in-manifest=$((plain + encoded))"

[ "$deployed" = "$EXPECTED" ] && [ "$((plain + encoded))" -eq 0 ]
