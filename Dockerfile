FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node licenses ./licenses
COPY scripts/docker-entrypoint.sh /usr/local/bin/arcade-entrypoint
COPY --chown=node:node scripts/restore-backup.ts scripts/twitch-ids.ts ./scripts/
RUN chmod +x /usr/local/bin/arcade-entrypoint
RUN test -s src/local-vectors.bin && test -s src/local-vocab.json && test -s src/semantic-model.json && test -s src/context-targets.json && test -s src/context-categories.json
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 BRB_DATA_DIR=/var/data
EXPOSE 8787
ENTRYPOINT ["arcade-entrypoint"]
CMD ["node", "--experimental-sqlite", "--experimental-strip-types", "src/server.ts"]
