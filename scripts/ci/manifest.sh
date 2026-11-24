#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh ci bash scripts/ci/manifest.sh <deployment.json> <expected-digest> [<more.json> …]
#
# Reads the Deployment that went into the cluster (kubectl get deploy -o json) and
# prints two numbers the pipeline cannot take on trust:
#
#   deployed-digest      the sha256 of the image the pod template names — must be the
#                        digest the build job produced, not a tag that points to it
#   secret-in-manifest   how many times any of the app's secret values occurs in the
#                        manifest, as is or base64-encoded — DB_PASSWORD and every
#                        other store value the pods read (SECRETS below). Counted
#                        here, where the values are known (from the store); the
#                        grader only ever sees the number. Any further files (the
#                        relay, consumer, migrate Job, Postgres, RabbitMQ) are
#                        scanned the same way.
#
# Exit 1 when the digest differs or the secret is in the manifest.

set -euo pipefail

MANIFEST="${1:?usage: $0 <deployment.json> <expected-digest>}"
EXPECTED="${2:?usage: $0 <deployment.json> <expected-digest>}"
shift 2
SCANNED=("$MANIFEST" "$@")
: "${DB_PASSWORD:?DB_PASSWORD is not set — run through scripts/with-secrets.sh}"
SECRETS="DB_PASSWORD BROKER_PASSWORD STORAGE_SECRET_KEY JWT_PRIVATE_KEY REFRESH_TOKEN_PEPPER PAYMENT_WEBHOOK_SECRET"

image="$(node -e 'console.log(require(process.argv[1]).spec.template.spec.containers[0].image)' "$(realpath "$MANIFEST")")"
case "$image" in
  *@sha256:*) deployed="${image##*@}" ;;
  *)          deployed="" ;;
esac

# grep -o: every occurrence, not every line; no match is a count of 0, not an error
count() { { cat "${SCANNED[@]}" | grep -oF -- "$1" || true; } | wc -l | tr -d ' '; }
found=0
checked=0
for name in $SECRETS; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  checked=$((checked + 1))
  found=$((found + $(count "$value") + $(count "$(printf '%s' "$value" | base64 | tr -d '\n')")))
done

echo "deployed-image=${image%@*}"
echo "deployed-digest=${deployed:-none}"
echo "manifests-scanned=${#SCANNED[@]}"
echo "secrets-checked=$checked"
echo "secret-in-manifest=$found"

[ "$deployed" = "$EXPECTED" ] && [ "$found" -eq 0 ]
