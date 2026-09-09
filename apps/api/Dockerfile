FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/src packages/contracts/src
COPY packages/domain packages/domain
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @argus/api... --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @argus/domain build && pnpm --filter @argus/api build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /workspace/packages/domain/dist ./packages/domain/dist
COPY --from=build /workspace/apps/api/src/database/migrations ./apps/api/dist/database/migrations
USER node
CMD ["node", "apps/api/dist/main.js"]
