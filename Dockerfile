FROM node:24-alpine AS native-builder

WORKDIR /build
RUN apk add --no-cache g++
COPY native ./native
ENV CXX=g++
RUN node native/build.js

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ORACLE_NATIVE_REQUIRED=true \
    ORACLE_STRICT_ARTIFACT_INTEGRITY=true

RUN apk add --no-cache libstdc++
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
COPY --from=native-builder /build/native/bin/oracle-engine ./native/bin/oracle-engine

RUN chmod +x ./native/bin/oracle-engine \
    && rm -rf tests docs native/src native/third_party \
    && rm -f native/CMakeLists.txt native/build.js \
    && mkdir -p /app/data/runtime \
    && chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/api/ready" >/dev/null || exit 1

CMD ["node", "server/index.js"]
