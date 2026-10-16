FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin webcrack
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server.mjs sandbox.mjs webcrack-runner.mjs worker.mjs entrypoint.sh ./
RUN chmod 0555 /app/server.mjs /app/sandbox.mjs /app/webcrack-runner.mjs /app/worker.mjs /app/entrypoint.sh
EXPOSE 8015
ENTRYPOINT ["/app/entrypoint.sh"]
