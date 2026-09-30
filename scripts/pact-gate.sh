#!/usr/bin/env bash
#
# The broker side of the contract loop: publish, tag, gate.
#
#   bash scripts/with-secrets.sh dev bash scripts/pact-gate.sh publish
#   bash scripts/with-secrets.sh dev bash scripts/pact-gate.sh tag-prod
#   bash scripts/with-secrets.sh dev bash scripts/pact-gate.sh can-i-deploy
#
# PACT_BROKER_URL and PACT_BROKER_TOKEN come from the environment and nowhere
# else — the store fills them locally (#11), GitHub secrets fill them in CI.
# The local compose broker needs no token, so an empty one is not an error.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONSUMER="${PACT_CONSUMER:-marketplace-web}"
PROVIDER="${PACT_PROVIDER:-marketplace-api}"
BROKER="${PACT_BROKER_URL:-http://127.0.0.1:9292}"
PACT_FILE="${PACT_FILE:-$ROOT/pacts/$CONSUMER-$PROVIDER.json}"
ENVIRONMENT_TAG="${PACT_ENVIRONMENT:-prod}"

version() {
  if [ -n "${PACT_PROVIDER_VERSION:-}" ]; then printf '%s' "$PACT_PROVIDER_VERSION"; return; fi
  git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf '0.0.0-local'
}

VERSION="$(version)"

call() {
  local method="$1" path="$2"
  shift 2
  if [ -n "${PACT_BROKER_TOKEN:-}" ]; then
    curl -sS -X "$method" "$BROKER$path" -H "Authorization: Bearer $PACT_BROKER_TOKEN" "$@"
  else
    curl -sS -X "$method" "$BROKER$path" "$@"
  fi
}

case "${1:-}" in
  publish)
    [ -f "$PACT_FILE" ] || { echo "No contract at $PACT_FILE — run npm run test:contract first." >&2; exit 1; }
    code="$(call PUT "/pacts/provider/$PROVIDER/consumer/$CONSUMER/version/$VERSION" \
      -H 'Content-Type: application/json' -d @"$PACT_FILE" -o /dev/null -w '%{http_code}')"
    echo "publish $CONSUMER@$VERSION → HTTP $code"
    [ "$code" = 200 ] || [ "$code" = 201 ]
    ;;

  tag-prod)
    # In a real pipeline the deploy job records this; here it is explicit so the
    # gate below has a provider version to compare against.
    code="$(call PUT "/pacticipants/$PROVIDER/versions/$VERSION/tags/$ENVIRONMENT_TAG" \
      -H 'Content-Type: application/json' -o /dev/null -w '%{http_code}')"
    echo "tag $PROVIDER@$VERSION as $ENVIRONMENT_TAG → HTTP $code"
    [ "$code" = 200 ] || [ "$code" = 201 ]
    ;;

  can-i-deploy)
    body="$(call GET "/can-i-deploy?pacticipant=$CONSUMER&version=$VERSION&to=$ENVIRONMENT_TAG")"
    printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        const { summary } = JSON.parse(raw);
        console.log(JSON.stringify(summary, null, 2));
        if (summary.deployable !== true) {
          console.error(`\ncan-i-deploy says no: ${summary.reason}`);
          process.exit(1);
        }
        console.log("\ndeployable: the contract is verified against what is in " + (process.env.PACT_ENVIRONMENT || "prod"));
      });'
    ;;

  *)
    echo "usage: bash scripts/pact-gate.sh publish|tag-prod|can-i-deploy" >&2
    exit 1
    ;;
esac
