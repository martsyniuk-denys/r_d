#!/usr/bin/env bash
#
#   bash scripts/cluster.sh up     # kind create (once) + kind load docker-image
#   bash scripts/cluster.sh down   # kind delete
#
# CI has no image on the host to load — it built and pushed one digest elsewhere:
#
#   bash scripts/cluster.sh create          # kind create only
#   bash scripts/cluster.sh pull <ref@sha256:…>
#                                   # crictl pull inside the node, by digest, with
#                                   # REGISTRY_USER/REGISTRY_TOKEN from the env (CI:
#                                   # the job's GITHUB_TOKEN, packages: read)
#
# The image is built on the host and does not exist inside the node until it is
# loaded; without the load the pod sits in ErrImagePull whatever imagePullPolicy says.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/k8s.sh"
cd "$ROOT"

create_cluster() {
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    echo "cluster $CLUSTER already exists"
  else
    kind create cluster --name "$CLUSTER" --config k8s/kind-config.yaml --wait 120s
  fi
}

case "${1:-}" in
  create)
    create_cluster
    kc get nodes
    ;;
  pull)
    ref="${2:?usage: $0 pull <image@sha256:...>}"
    case "$ref" in *@sha256:*) ;; *) echo "cluster:pull: $ref is not pinned by digest" >&2; exit 2 ;; esac
    : "${REGISTRY_USER:?REGISTRY_USER is not set}" "${REGISTRY_TOKEN:?REGISTRY_TOKEN is not set}"
    # Into the node's containerd, so the digest there is the registry's digest — what
    # the pod spec names. A `kind load` of a host image would re-pack it under another.
    docker exec "$CLUSTER-control-plane" crictl pull --creds "$REGISTRY_USER:$REGISTRY_TOKEN" "$ref" >/dev/null
    docker exec "$CLUSTER-control-plane" crictl inspecti -o go-template --template '{{index .status.repoDigests 0}}' "$ref"
    echo
    ;;
  up)
    create_cluster
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
    echo "usage: $0 up|down|create|pull <ref>" >&2
    exit 2
    ;;
esac
