# Bun runs TypeScript jobs; Node runs Next and JavaScript scorers; Python runs Python scorers.
FROM oven/bun:1.3.14 AS bun
FROM docker:29-cli AS docker-cli
FROM node:22-bookworm-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY . .
# Runtime UI dependencies currently live in devDependencies too; do not prune them.
# Next's TypeScript worker exceeds Node 22's default heap on CI. Give only the
# build a 4 GiB heap; the runtime stage keeps Node's default memory settings.
RUN bun install --frozen-lockfile && NODE_OPTIONS=--max-old-space-size=4096 bun run build
# Build caches are never needed by next start or the ingestion worker. Remove
# them before the runtime COPY so they do not occupy a production image layer.
RUN rm -rf /app/.next/cache

FROM base AS runtime
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 DATOOL_DATA_DIR=/app/.data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build /app/package.json /app/tsconfig.json /app/next.config.ts /app/Procfile /app/app.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/lib ./lib
COPY --from=build /app/components ./components
# Ship only release, worker, and operator commands. Test harnesses are injected
# into disposable acceptance containers by the host-side test runner.
COPY --from=build /app/scripts/alerts-worker.ts \
    /app/scripts/backfill-eval-attribution.ts \
    /app/scripts/backfill-missing-costs.ts \
    /app/scripts/check-self-hosting.mjs \
    /app/scripts/cms-local-database.ts \
    /app/scripts/cms-seed-options.ts \
    /app/scripts/execution-credits.ts \
    /app/scripts/ingestion-jobs.ts \
    /app/scripts/ingestion-worker.ts \
    /app/scripts/langfuse-import.ts \
    /app/scripts/migrate.ts \
    /app/scripts/provision-alert-reader.ts \
    /app/scripts/release.sh \
    /app/scripts/seed-cms.ts ./scripts/
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/payload.config.ts /app/payload-types.ts ./
COPY --from=build /app/cms ./cms
COPY --from=build /app/payload-migrations ./payload-migrations
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
