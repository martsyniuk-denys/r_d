# syntax=docker/dockerfile:1.7
#
# Production image of the marketplace API.
#
#   npm run image:build   # DOCKER_BUILDKIT, --secret id=npm_token,src=.npm_token
#
# Four stages, and only the last one ships: node:22-bookworm-slim compiles and
# installs, gcr.io/distroless/nodejs22-debian12:nonroot runs. Same Debian 12 and the
# same glibc on both sides, so a native module built in the builder loads in the
# runtime. The runtime has no shell, no package manager and no root: after an RCE
# there is no `sh` to drop into.
#
# The registry token is a BuildKit secret: mounted as a file for the duration of one
# RUN, never an ARG (that lands in `docker history` and the image config) and never a
# COPY + rm (the rm is a whiteout; the bytes stay in the earlier layer). It is bound
# to the scope of the private registry only, so public packages never see it.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=cache,target=/root/.npm \
    printf '@marketplace-private:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=%s\n' \
      "$(cat /run/secrets/npm_token)" > /tmp/npmrc \
 && npm ci --userconfig /tmp/npmrc --no-audit --no-fund \
 ; status=$?; rm -f /tmp/npmrc; exit $status

FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=cache,target=/root/.npm \
    printf '@marketplace-private:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=%s\n' \
      "$(cat /run/secrets/npm_token)" > /tmp/npmrc \
 && npm ci --omit=dev --userconfig /tmp/npmrc --no-audit --no-fund \
 ; status=$?; rm -f /tmp/npmrc; exit $status

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY openapi ./openapi
# The code stays owned by root: uid 65532 can read and run it, never rewrite it.
# Numeric, not "nonroot": kubelet cannot resolve a name to check runAsNonRoot.
USER 65532:65532
EXPOSE 3000
CMD ["dist/k8s-pod.js"]
