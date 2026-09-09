FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/src packages/contracts/src
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @argus/web... --frozen-lockfile
COPY apps/web apps/web
ENV ARGUS_STANDALONE_BUILD=true
RUN pnpm --filter @argus/web build

FROM build AS development
ENV NODE_ENV=development
EXPOSE 3000
CMD ["pnpm", "--filter", "@argus/web", "dev"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /workspace/apps/web/.next/standalone ./
COPY --from=build /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
