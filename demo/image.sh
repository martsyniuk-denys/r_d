#!/usr/bin/env bash
#
#   npm run demo:image
#
# Measures the built image, it does not read claims about it:
#
#   stages          FROM lines of docker/Dockerfile
#   shell-inside    1 if `docker run --entrypoint sh|/bin/sh|/busybox/sh` starts
#   runtime-uid     process.getuid() of node inside the image, as it runs by default
#   token-in-*      occurrences of the build-stage token (.npm_token) in
#                     history — `docker history --no-trunc` lines   (what an ARG leaks)
#                     config  — `docker image inspect` lines        (ARG/ENV in metadata)
#                     layers  — layer tarballs of `docker save`     (what COPY + rm leaks)
#
# No single tool sees both leaks: an ARG is all over history and nowhere in the layers,
# a COPY + rm is nowhere in history and still inside an earlier layer under a whiteout.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib/k8s.sh"
cd "$ROOT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "demo:image: $IMAGE is not built — npm run image:build first" >&2
  exit 1
fi
if [ ! -s .npm_token ]; then
  echo "demo:image: .npm_token is missing — nothing to search the image for" >&2
  exit 1
fi
TOKEN="$(tr -d '\r\n' < .npm_token)"
[ -n "$TOKEN" ] || { echo "demo:image: .npm_token is empty" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

stages=$(grep -ciE '^[[:space:]]*FROM[[:space:]]' docker/Dockerfile || true)

shell=0
for sh in sh /bin/sh /busybox/sh; do
  if docker run --rm --entrypoint "$sh" "$IMAGE" -c 'exit 0' >/dev/null 2>&1; then
    echo "# shell found: $sh"
    shell=1
  fi
done

uid=$(docker run --rm "$IMAGE" -e 'process.stdout.write(String(process.getuid()))' 2>/dev/null || true)

in_history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE" | grep -cF -- "$TOKEN" || true)
in_config=$(docker image inspect "$IMAGE" | grep -cF -- "$TOKEN" || true)

docker save "$IMAGE" -o "$WORK/image.tar"
mkdir "$WORK/x"
tar -xf "$WORK/image.tar" -C "$WORK/x"
layers=$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  for (const l of m[0].Layers) console.log(l);' "$WORK/x/manifest.json")

in_layers=0
total_layers=0
for layer in $layers; do
  total_layers=$((total_layers + 1))
  file="$WORK/x/$layer"
  magic=$(head -c 4 "$file" | od -An -tx1 | tr -d ' \n')
  case "$magic" in
    1f8b*)    reader=(gzip -dc) ;;
    28b52ffd) reader=(zstd -dc) ;;
    *)        reader=(cat) ;;
  esac
  # Decompress fully first: an unreadable layer must fail the demo, not count as clean.
  if ! "${reader[@]}" "$file" > "$WORK/layer.tar"; then
    echo "demo:image: cannot read $layer with ${reader[0]}" >&2
    exit 1
  fi
  if grep -qaF -- "$TOKEN" "$WORK/layer.tar"; then
    echo "# token found in $layer"
    in_layers=$((in_layers + 1))
  fi
done

echo "image=$IMAGE"
echo "layers-searched=$total_layers"
echo "stages=$stages"
echo "shell-inside=$shell"
echo "runtime-uid=$uid"
echo "token-in-history=$in_history"
echo "token-in-config=$in_config"
echo "token-in-layers=$in_layers"
