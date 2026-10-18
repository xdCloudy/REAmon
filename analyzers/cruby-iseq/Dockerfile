FROM ruby:3.4.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin cruby-iseq \
    && rm -rf /var/lib/apt/lists/*

ENV REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    CRUBY_ISEQ_MAX_INPUT_BYTES=16777216 \
    CRUBY_ISEQ_MAX_OUTPUT_BYTES=524288 \
    CRUBY_ISEQ_TIMEOUT_SECONDS=35

WORKDIR /app
COPY server.rb worker.rb entrypoint.sh ./
RUN chmod 0555 /app/server.rb /app/worker.rb /app/entrypoint.sh
EXPOSE 8030
ENTRYPOINT ["/app/entrypoint.sh"]
