FROM rust:1.89-bookworm AS build

ARG UNIVDREAMS_REVISION=f02c749da48a4f379210dfa72e7cb2ccfeaf1fc9
ARG UNIVDREAMS_SOURCE_SHA256=50baa74e31ae28700278bdcf996c4b072b45658b7c46ae37ef3f0ba4f5af6691

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/* \
 && curl --proto '=https' --tlsv1.2 -fsSL "https://codeload.github.com/KarpelesLab/univdreams/tar.gz/${UNIVDREAMS_REVISION}" -o /tmp/univdreams.tar.gz \
 && echo "${UNIVDREAMS_SOURCE_SHA256}  /tmp/univdreams.tar.gz" | sha256sum -c - \
 && mkdir -p /src/univdreams \
 && tar -xzf /tmp/univdreams.tar.gz --strip-components=1 -C /src/univdreams \
 && rm /tmp/univdreams.tar.gz

WORKDIR /src/univdreams
COPY Cargo.lock /tmp/reamon-univdreams-Cargo.lock
RUN cp /tmp/reamon-univdreams-Cargo.lock Cargo.lock \
 && RUSTUP_TOOLCHAIN=1.89.0 cargo build --locked --release --bin ud

FROM debian:bookworm-slim

ARG UNIVDREAMS_REVISION=f02c749da48a4f379210dfa72e7cb2ccfeaf1fc9

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates passwd python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10012 --no-create-home --shell /usr/sbin/nologin univdreams \
 && mkdir -p /usr/share/licenses/univdreams

COPY --from=build /src/univdreams/target/release/ud /usr/local/bin/ud
COPY --from=build /src/univdreams/LICENSE /usr/share/licenses/univdreams/LICENSE
COPY server.py /app/server.py

RUN chmod 0555 /usr/local/bin/ud /app/server.py

ENV UNIVDREAMS_BIN=/usr/local/bin/ud \
    UNIVDREAMS_VERSION=0.4.0 \
    UNIVDREAMS_PROVIDER_REVISION=${UNIVDREAMS_REVISION} \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
EXPOSE 8032
USER 10012:10012
CMD ["python3", "/app/server.py"]
