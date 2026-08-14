# aequilibri app image (AWS plan B2/B3). One Dockerfile, two push targets:
#
#   --target runner   (default) — the app task: Next standalone output on
#                     node:24-slim, non-root, port 3000.
#   --target migrate  — the release task: same build layers plus the full
#                     node_modules, running scripts/migrate-all-tenants.mjs
#                     (needs the prisma CLI, which the standalone output
#                     deliberately lacks — that's why it's a second target,
#                     not a second image build).
#
# Build:  docker build -t aequilibri-app --target runner .
#         docker build -t aequilibri-migrate --target migrate .
# Run:    docker run -p 3000:3000 --env-file .env aequilibri-app

# ── deps: install once, shared by build + migrate ───────────────────────────
FROM node:24-slim AS deps
WORKDIR /app
# Prisma engines need OpenSSL present even at generate time on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ── build: prisma clients + Next standalone output ──────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
# Clerk publishable key is public by design but must be present at build:
# Next inlines NEXT_PUBLIC_* into the client bundle.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# Auth flows stay on our origin (in-app pages), never the hosted portal.
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
# Build-time placeholders only — the boot guard warns (not throws) and no
# page connects at build; real values come from Secrets Manager at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    CONTROL_DATABASE_URL="postgresql://build:build@localhost:5432/build_control" \
    DIRECT_URL="postgresql://build:build@localhost:5432/build" \
    CONTROL_DIRECT_URL="postgresql://build:build@localhost:5432/build_control" \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run db:generate && npm run build

# ── migrate: the one-off release task (full node_modules + prisma CLI) ──────
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "scripts/migrate-all-tenants.mjs"]

# ── runner: the app task (traced standalone output only) ────────────────────
FROM node:24-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
# Standalone output = server.js + file-traced node_modules (includes the
# generated prisma clients and the serverExternalPackages natives).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Belt-and-braces for the natives Next must load from node_modules at runtime
# (next.config serverExternalPackages) — overwrite whatever tracing carried.
COPY --from=build --chown=node:node /app/node_modules/@napi-rs ./node_modules/@napi-rs
COPY --from=build --chown=node:node /app/node_modules/geotiff ./node_modules/geotiff
USER node
EXPOSE 3000
CMD ["node", "server.js"]
