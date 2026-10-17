FROM python:3.12-slim-bookworm AS build
ARG GLAURUNG_COMMIT=8980d4e32dea59ad85f4c3d685c1b43762fd329e
ENV GIT_LFS_SKIP_SMUDGE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates clang curl git libclang-dev libssl-dev pkg-config \
 && rm -rf /var/lib/apt/lists/* \
 && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /build
RUN git init glaurung \
 && git -C glaurung remote add origin https://github.com/mjbommar/glaurung.git \
 && git -C glaurung fetch --depth 1 origin "${GLAURUNG_COMMIT}" \
 && git -C glaurung checkout --detach FETCH_HEAD
WORKDIR /build/glaurung
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
RUN uv sync --locked --no-dev

FROM python:3.12-slim-bookworm
ARG GLAURUNG_COMMIT=8980d4e32dea59ad85f4c3d685c1b43762fd329e
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 libgcc-s1 libgomp1 libssl3 util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin glaurung
WORKDIR /opt/glaurung
COPY --from=build --chown=10002:10002 /build/glaurung/.venv /opt/glaurung/.venv
COPY --from=build --chown=10002:10002 /build/glaurung/python/glaurung /opt/glaurung/python/glaurung
COPY --from=build --chown=10002:10002 /build/glaurung/data /opt/glaurung/data
COPY --from=build /build/glaurung/LICENSE /licenses/glaurung/LICENSE
ENV PATH="/opt/glaurung/.venv/bin:${PATH}" \
    PYTHONPATH="/opt/glaurung/python" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    GLAURUNG_ROOT=/opt/glaurung
WORKDIR /app
COPY server.py worker.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/worker.py /app/entrypoint.sh
ENV GLAURUNG_PROVIDER_REVISION="${GLAURUNG_COMMIT}"
EXPOSE 8024
ENTRYPOINT ["/app/entrypoint.sh"]
