FROM rust:1.89-bookworm AS build
ARG DEX_DECOMPILER_COMMIT=d458efd15d74351e83f4e8968c75ef17c71f3c65
RUN git clone --filter=blob:none https://github.com/androguard/dex-decompiler.git /src \
 && git -C /src checkout --detach "${DEX_DECOMPILER_COMMIT}"
WORKDIR /src
COPY Cargo.lock /src/Cargo.lock
COPY structured-analysis.rs /src/src/bin/reamon-dex-structure.rs
COPY deobf-map.rs /src/src/bin/reamon-dex-map.rs
COPY bounded-decompile.rs /src/src/bin/reamon-dex-batch.rs
COPY upstream-unicode-rename.patch /tmp/upstream-unicode-rename.patch
RUN git -C /src apply --check /tmp/upstream-unicode-rename.patch \
 && git -C /src apply /tmp/upstream-unicode-rename.patch
RUN cargo build --release --locked --bin dex-decompile --bin reamon-dex-structure --bin reamon-dex-map --bin reamon-dex-batch

FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin dex-decompiler \
 && mkdir -p /usr/share/licenses/dex-decompiler \
 && chmod 0555 /usr/share/licenses/dex-decompiler
COPY --from=build /src/target/release/dex-decompile /usr/local/bin/dex-decompile
COPY --from=build /src/target/release/reamon-dex-structure /usr/local/bin/reamon-dex-structure
COPY --from=build /src/target/release/reamon-dex-map /usr/local/bin/reamon-dex-map
COPY --from=build /src/target/release/reamon-dex-batch /usr/local/bin/reamon-dex-batch
COPY --from=build /src/LICENSE /usr/share/licenses/dex-decompiler/LICENSE
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/entrypoint.sh /usr/local/bin/dex-decompile /usr/local/bin/reamon-dex-structure /usr/local/bin/reamon-dex-map /usr/local/bin/reamon-dex-batch
ENV REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    DEX_DECOMPILER_TIMEOUT_SECONDS=900 \
    DEX_DECOMPILER_MAX_OUTPUT_BYTES=536870912 \
    DEX_DECOMPILER_MAX_RETURNED_UNITS=500
EXPOSE 8019
ENTRYPOINT ["/app/entrypoint.sh"]
