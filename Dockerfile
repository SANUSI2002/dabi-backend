# Build this from the backend repository root, never the frontend parent folder.
# Resolve/pin the vendor image digest in the release pipeline before promotion.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json ./
# Dependency install hooks may inspect Prisma configuration. This is deliberately
# non-connecting build metadata, not a runtime credential.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/build npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./
# Generation needs a syntactically valid URL, but never connects to this database.
# Do not pass a production secret as a build ARG or bake .env into the image.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/build ./node_modules/.bin/prisma generate

# Migrations run once, separately from API startup, with a migration identity.
# Keep Prisma CLI here; it is a devDependency and absent from the runtime target.
FROM dependencies AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
# Preserve the generated client explicitly even if npm's pruning behavior changes.
COPY --chown=node:node --from=dependencies /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node docs ./docs
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
