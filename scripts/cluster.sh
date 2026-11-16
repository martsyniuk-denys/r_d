#!/usr/bin/env bash
#
#   bash scripts/cluster.sh up     # kind create (once) + kind load docker-image
#   bash scripts/cluster.sh down   # kind delete
#
# The image is built on the host and does not exist inside the node until it is
# loaded; without the load the pod sits in ErrImagePull whatever imagePullPolicy says.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/k8s.sh"
cd "$ROOT"

case "${1:-}" in
  up)
    if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
      echo "cluster $CLUSTER already exists"
    else
      kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml --wait 120s
    fi
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "cluster:up: image $IMAGE is not built — npm run image:build first" >&2
      exit 1
    fi
    kind load docker-image "$IMAGE" --name "$CLUSTER"
    kc get nodes
    ;;
  down)
    kind delete cluster --name "$CLUSTER"
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
