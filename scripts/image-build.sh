#!/usr/bin/env bash
#
# Builds docker/Dockerfile into $IMAGE. The registry token goes in as a BuildKit
# secret from .npm_token (git-ignored, docker-ignored) and nowhere else.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/k8s.sh"
cd "$ROOT"

if [ ! -s .npm_token ]; then
  echo "image:build: .npm_token is missing or empty — the build-stage registry token." >&2
  echo "  no private registry: a decoy will do, e.g. openssl rand -hex 16 > .npm_token" >&2
  exit 1
fi

DOCKER_BUILDKIT=1 docker build \
  -f docker/Dockerfile \
  --secret id=npm_token,src=.npm_token \
  -t "$IMAGE" \
  .
echo "built $IMAGE"
