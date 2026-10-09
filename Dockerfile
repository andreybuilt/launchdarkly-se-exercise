# syntax=docker/dockerfile:1

# Stage 1: build. Installs all dependencies (including the esbuild
# devDependency) and runs the client bundle step, so the runtime stage
# never needs build tooling.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:client

# Stage 2: runtime. Only production dependencies, the server source, and
# the already-built browser bundle. No esbuild, no devDependencies.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY --from=build /app/public/bundle.js ./public/bundle.js
COPY --from=build /app/public/bundle.js.map ./public/bundle.js.map

# Run as a non-root user rather than the alpine image's default root.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.mjs"]
