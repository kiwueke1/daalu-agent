FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --legacy-peer-deps

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# next.config.js bakes the API-proxy rewrite destination from this at BUILD
# time (rewrites are stored in the routes-manifest, not read at runtime), so it
# must be set here. Default to the in-cluster compose service name `api` — the
# browser never uses this (the client calls the relative `/api/v1` and Next
# proxies server-side); only the proxy target needs it. Local `next dev` (no
# Docker) still falls back to http://localhost:8000 via next.config.js.
ARG NEXT_PUBLIC_API_BASE_URL=http://api:8000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# node:20-alpine already ships a `node` user/group at UID/GID 1000 — reuse
# it instead of trying to create another at the same id (the original
# `addgroup -g 1000 nodejs` failed because GID 1000 was already taken).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
