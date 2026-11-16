#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh dev bash scripts/aws.sh base|demo up|preview|destroy
#
# One Pulumi program per stack: infra/base (stack `base`, $0, may stay for a week)
# and infra/demo (stack `demo`, billed by the hour, lives for a session).
#
# Backend: PULUMI_BACKEND_URL, file://<repo>/.pulumi by default — the fallback lane
# (LocalStack) has nothing to bill, and the task allows a file backend there. The
# main lane sets PULUMI_BACKEND_URL to Pulumi Cloud or an s3:// bucket, because CI
# must reach the state to destroy it. Nothing here runs `pulumi login`: the backend
# is a variable of this process, not a global setting of the machine.
#
# The region is not read from ~/.aws/config or AWS_REGION: it is pinned in each
# stack's Pulumi.<stack>.yaml, and scripts/aws-checks.sh reads it from there.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${1:-}"; ACTION="${2:-}"
case "$STACK" in base|demo) ;; *) echo "usage: $0 base|demo up|preview|destroy" >&2; exit 2 ;; esac

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true
case "$PULUMI_BACKEND_URL" in
  file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;;
esac
: "${PULUMI_CONFIG_PASSPHRASE:?comes from the store: openssl rand -hex 24 > secrets/pulumi_passphrase}"

DIR="$ROOT/infra/$STACK"
[ -d "$DIR/node_modules" ] || npm --prefix "$DIR" ci --no-audit --no-fund

cd "$DIR"
pulumi stack select "$STACK" --create --non-interactive >/dev/null

case "$ACTION" in
  up)      pulumi up --yes --non-interactive --skip-preview ;;
  preview) pulumi preview --non-interactive --diff ;;
  # destroy → export → checks, in this order: after `--remove` there is no state left
  # to export, and the check that reads it would report an honest-looking nothing.
  destroy) pulumi destroy --yes --non-interactive --skip-preview ;;
  *)       echo "usage: $0 base|demo up|preview|destroy" >&2; exit 2 ;;
esac
