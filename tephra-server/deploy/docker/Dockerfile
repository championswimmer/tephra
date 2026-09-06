# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY tephra-plugin/package.json ./tephra-plugin/package.json
COPY tephra-server/apps/api/package.json ./tephra-server/apps/api/package.json
COPY tephra-server/apps/web/package.json ./tephra-server/apps/web/package.json
COPY tephra-server/packages ./tephra-server/packages
RUN npm ci

COPY tsconfig.base.json eslint.config.mjs .prettierrc.json ./
COPY tephra-plugin ./tephra-plugin
COPY tephra-server ./tephra-server
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    TEPHRA_DATABASE_DRIVER=sqlite \
    TEPHRA_SQLITE_PATH=/data/tephra.db \
    TEPHRA_BLOB_DRIVER=filesystem \
    TEPHRA_BLOB_PATH=/data/blobs \
    TEPHRA_ALLOW_SIGNUPS=false \
    TEPHRA_MAX_BLOB_BYTES=104857600 \
    TEPHRA_LOG_LEVEL=info

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/tephra-server ./tephra-server

RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "run", "start", "--workspace=@tephra/api"]
