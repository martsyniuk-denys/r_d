# syntax=docker/dockerfile:1

# ---- builder: dev dependencies + sources + tests, this is where `npm test` runs ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

CMD ["npm", "test"]

# ---- runner: production dependencies + compiled output only ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

CMD ["node", "dist/src/main.js"]
