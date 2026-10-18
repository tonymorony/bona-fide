# The Bona Fide App's Node host. Build it from a directory laid out like the repo root, with the
# workspace's package.json and package-lock.json, sdk/ and app/, such as the repo root itself:
#   docker build -f deploy/Dockerfile -t bona-fide-app .
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /srv

COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY app/package.json app/
# Only the App's dependencies, with the SDK linked from sdk/.
# --omit=optional also drops TypeScript, an optional peer of viem: Node strips the types itself.
RUN npm ci --workspace app --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm

COPY sdk/src sdk/src
COPY app/src app/src

# The decision log's volume: a new volume takes this directory's owner, so the App can write to it.
RUN mkdir /data && chown node:node /data

USER node
WORKDIR /srv/app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/node.ts"]
