FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin unluac-rs \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs worker.mjs entrypoint.sh ./
RUN chmod 0555 /app/server.mjs /app/worker.mjs /app/entrypoint.sh
EXPOSE 8018
ENTRYPOINT ["/app/entrypoint.sh"]
