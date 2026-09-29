# The Bona Fide App's Node host. Build it from a directory that holds app/, such as the repo root:
#   docker build -f deploy/Dockerfile -t bona-fide-app .
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY app/package.json app/package-lock.json ./
# --omit=optional also drops TypeScript, an optional peer of viem: Node strips the types itself.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm

COPY app/src ./src

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/node.ts"]
