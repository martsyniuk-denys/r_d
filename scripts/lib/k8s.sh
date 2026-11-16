# Names shared by the cluster, image, Pulumi and demo scripts. They must agree with
# infra/Pulumi.dev.yaml; the Pulumi program itself reads only its stack config.
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMAGE="${IMAGE:-marketplace-api:1.0.0}"
CLUSTER="${CLUSTER:-marketplace}"
KUBE_CONTEXT="kind-$CLUSTER"
NAMESPACE="${NAMESPACE:-marketplace}"
DEPLOYMENT="${DEPLOYMENT:-marketplace-api}"
PDB="${PDB:-marketplace-api}"
NODE_PORT="${NODE_PORT:-30080}"
STACK="${STACK:-dev}"

kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# REV in the pod template of the running Deployment; empty when there is none.
current_rev() {
  kc -n "$NAMESPACE" get deploy "$DEPLOYMENT" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="REV")].value}' 2>/dev/null || true
}
