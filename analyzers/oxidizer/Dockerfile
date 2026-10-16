FROM python:3.12-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
WORKDIR /build
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux libstdc++6 libgcc-s1 libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin oxidizer
COPY --from=build /build/.venv /opt/venv
WORKDIR /app
COPY server.py worker.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/worker.py /app/entrypoint.sh
ENV PATH="/opt/venv/bin:${PATH}" \
    OXIDIZER_PROVIDER_REVISION=angr-10.0.4
EXPOSE 8020
ENTRYPOINT ["/app/entrypoint.sh"]
