FROM rust:1.89-bookworm AS build

ARG RECURSE_COMMIT=34ff28af22e6724d29e100001ef79dfe2a001d15

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/* \
 && git init /src \
 && git -C /src remote add origin https://github.com/Recurse-Labs/recurse.git \
 && git -C /src fetch --depth 1 origin "${RECURSE_COMMIT}" \
 && git -C /src checkout --detach FETCH_HEAD \
 && test "$(git -C /src rev-parse HEAD)" = "${RECURSE_COMMIT}"

WORKDIR /src
RUN cargo build --locked --release --package recurse-mcp

FROM python:3.11-slim-bookworm

ARG RECURSE_COMMIT=34ff28af22e6724d29e100001ef79dfe2a001d15

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates passwd \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10004 --no-create-home --shell /usr/sbin/nologin recurse \
 && mkdir -p /licenses/recurse

COPY --from=build /src/target/release/recurse-mcp /usr/local/bin/recurse-mcp
COPY --from=build /src/LICENSE /licenses/recurse/LICENSE
COPY server.py /app/server.py
RUN chmod 0555 /usr/local/bin/recurse-mcp /app/server.py

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    RECURSE_PROVIDER_REVISION="${RECURSE_COMMIT}" \
    RECURSE_VERSION=0.1.0

WORKDIR /app
EXPOSE 8026
USER 10004:10004
CMD ["python3", "/app/server.py"]
