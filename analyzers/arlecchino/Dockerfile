FROM rust:1.86-bookworm AS build
ARG ARLECCHINO_COMMIT=de3e7b0bbc4c99d45a5baa63f8f8f05532b80363
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && git init /src \
 && git -C /src remote add origin https://github.com/wehrwolfmann/arlecchino.git \
 && git -C /src fetch --depth 1 origin "${ARLECCHINO_COMMIT}" \
 && git -C /src checkout --detach FETCH_HEAD \
 && test "$(git -C /src rev-parse HEAD)" = "${ARLECCHINO_COMMIT}"
WORKDIR /src
RUN cargo build --locked --release --bin arlecchino

FROM ubuntu:24.04 AS engines
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jdk-headless passwd python3 unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/arlecchino /opt/arlecchino/bin/arlecchino
COPY --from=build /src/LICENSE /opt/arlecchino/LICENSE
COPY --from=build /src/NOTICE /opt/arlecchino/NOTICE
COPY engines.toml /opt/arlecchino/engines.toml
COPY CFR_LICENSE.md /usr/share/licenses/arlecchino/CFR_LICENSE
COPY VINEFLOWER_LICENSE.md /usr/share/licenses/arlecchino/VINEFLOWER_LICENSE
COPY JADX_LICENSE /usr/share/licenses/jadx/LICENSE
RUN chmod 0555 /opt/arlecchino/bin/arlecchino \
 && ARLECCHINO_VINEFLOWER_VERSION=1.12.0 ARLECCHINO_CFR_VERSION=0.152 ARLECCHINO_JADX_VERSION=v1.5.6 \
    /opt/arlecchino/bin/arlecchino setup --engines-root /opt/arlecchino/engines --only vineflower,cfr,asm --no-freej2me \
 && echo 'f686e8f3ded377d7bc87d216a90e9e9512df4156e75b06c655a16648ae8765b2  /opt/arlecchino/engines/cfr.jar' | sha256sum --check --status \
 && echo '1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d  /opt/arlecchino/engines/vineflower.jar' | sha256sum --check --status \
 && curl --proto '=https' --tlsv1.2 -fsSL https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip -o /tmp/jadx.zip \
 && echo '545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974  /tmp/jadx.zip' | sha256sum --check --status \
 && mkdir -p /opt/arlecchino/engines/jadx \
 && unzip -q /tmp/jadx.zip -d /opt/arlecchino/engines/jadx \
 && rm /tmp/jadx.zip \
 && chmod 0555 /opt/arlecchino/engines/jadx/bin/jadx \
 && test -x /opt/arlecchino/engines/jadx/bin/jadx \
 && test -f /opt/arlecchino/engines/asm/_classes/MemberRenamer.class \
 && mkdir -p /usr/share/licenses/arlecchino /usr/share/licenses/jadx \
 && cp /opt/arlecchino/LICENSE /usr/share/licenses/arlecchino/LICENSE \
 && cp /opt/arlecchino/NOTICE /usr/share/licenses/arlecchino/NOTICE \
 && curl --proto '=https' --tlsv1.2 -fsSL https://asm.ow2.io/license.html -o /usr/share/licenses/arlecchino/ASM_LICENSE.html \
 && chmod -R a+rX /opt/arlecchino /usr/share/licenses

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openjdk-21-jdk-headless passwd python3 util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin arlecchino
COPY --from=engines /opt/arlecchino /opt/arlecchino
COPY --from=engines /usr/share/licenses /usr/share/licenses
COPY ARLECCHINO_LICENSE ARLECCHINO_NOTICE CFR_LICENSE.md JADX_LICENSE VINEFLOWER_LICENSE.md /usr/share/licenses/arlecchino/
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    ARLECCHINO_BIN=/opt/arlecchino/bin/arlecchino \
    ARLECCHINO_CONFIG=/opt/arlecchino/engines.toml \
    ARLECCHINO_ENGINES_ROOT=/opt/arlecchino/engines \
    ARLECCHINO_TIMEOUT_SECONDS=900 \
    ARLECCHINO_MAX_OUTPUT_BYTES=536870912 \
    ARLECCHINO_MAX_SOURCE_FILES=20000 \
    JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=60
EXPOSE 8028
ENTRYPOINT ["/app/entrypoint.sh"]
