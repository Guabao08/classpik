# syntax=docker/dockerfile:1
#
# ClassPik monitor. Build context is apps/monitor:
#
#   docker build -t classpik-monitor apps/monitor
#
# Three stages, and the split is not decoration. The service has exactly one
# runtime dependency, "yaml". Everything else in package.json is TypeScript,
# tsx and vitest, which are needed to produce the JavaScript and never to run
# it. Building in one image and running from another keeps a compiler and a
# test runner out of the thing exposed to the internet.

# ---------------------------------------------------------------- build stage
FROM node:24-slim AS build
WORKDIR /app

# package files first, so a source edit does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsconfig.build.json extends the strict config, so this cannot pass with looser
# rules than `npm run typecheck` enforces. A type error fails the image build.
RUN npx tsc -p tsconfig.build.json

# ----------------------------------------------------- runtime deps stage
# A second, clean `npm ci --omit=dev` rather than pruning the build stage's
# tree. Pruning leaves whatever npm decided to leave; this produces the set a
# fresh production install would, which is the set the lockfile describes.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# -------------------------------------------------------------- runtime stage
FROM node:24-slim AS runtime

# NODE_ENV is read by npm and by nothing in this codebase; it is set so anything
# added later that does read it sees the truth.
ENV NODE_ENV=production \
    PORT=8787 \
    CLASSPIK_DB=/data/classpik.db

WORKDIR /app

# Application files stay owned by root while the process runs as node, so the
# service cannot rewrite its own code. The one path it must write to is /data.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# "type": "module" lives here, and dist/*.js will not load as ESM without it.
COPY package.json ./
COPY schools ./schools
COPY docker/entrypoint.mjs ./docker/entrypoint.mjs

# The database must not live in an image layer. A layer is recreated on every
# deploy, so a database written there is a database silently discarded on the
# next `docker build`, taking every account, watch and event with it. /data is
# a mount point, and the entrypoint refuses to start if it is not writable.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# node:24-slim ships this user at uid 1000. Nothing here needs root, and a poll
# loop that talks to the public internet should not have it.
USER node

EXPOSE 8787

# No curl in this image, and adding one to poll a local port would be a package
# in the runtime image for the sake of a health check. Node has fetch built in.
# start-period covers migration and the first tick on a cold volume.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# src/index.ts installs SIGTERM and SIGINT handlers that stop the runner, close
# the server and close the database, so node is a correct PID 1 here and
# `docker stop` is a clean shutdown rather than a killed writer.
ENTRYPOINT ["node", "docker/entrypoint.mjs"]
