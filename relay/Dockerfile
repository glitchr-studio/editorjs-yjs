# Auth-gated y-websocket relay for editorjs-yjs. See README.md for the
# docker-compose + reverse-proxy snippet a consuming app adds to wire this in.
# The app builds this image straight from the editorjs-yjs repository, pinned
# to a commit: context: <repo>.git#<commit>:relay
FROM node:20-alpine

WORKDIR /srv/relay

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY src/ ./src/

ENV COLLAB_RELAY_PORT=1234
EXPOSE 1234

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:1234/health || exit 1

CMD ["node", "src/server.js"]
