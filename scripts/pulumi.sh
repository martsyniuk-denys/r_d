#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh dev bash scripts/pulumi.sh up|preview|plan|destroy
#
# plan = `pulumi preview --json`, nothing else on stdout: CI keeps it as plan.json and
# the cost gate (npm run gate:cost) reads it.
#
# The backend is a local directory, never a Pulumi Cloud login: PULUMI_BACKEND_URL
# defaults to file://<repo>/.pulumi. The state is encrypted with
# PULUMI_CONFIG_PASSPHRASE, which comes from the store like DB_PASSWORD does.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/k8s.sh"

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true
case "$PULUMI_BACKEND_URL" in
  file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;;
esac

[ -d "$ROOT/infra/node_modules" ] || npm --prefix "$ROOT/infra" ci --no-audit --no-fund >&2

# The revision in the pod template only moves when asked to (demo:rollout sets it);
# a plain `up` keeps whatever is running, so it does not trigger a rollout by itself.
if [ -z "${APP_REV:-}" ]; then
  APP_REV="$(current_rev)"
fi
export APP_REV="${APP_REV:-1}"

cd "$ROOT/infra"
pulumi stack select "$STACK" --create --non-interactive >&2

case "${1:-}" in
  up)      pulumi up --yes --non-interactive --skip-preview ;;
  preview) pulumi preview --non-interactive ;;
  plan)    pulumi preview --json --non-interactive ;;
  destroy) pulumi destroy --yes --non-interactive --skip-preview ;;
  *)       echo "usage: $0 up|preview|plan|destroy" >&2; exit 2 ;;
esac
