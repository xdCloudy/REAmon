FROM python:3.12-slim
ARG JADX_VERSION=1.5.6
ARG JADX_SHA256=545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jre-headless unzip util-linux && rm -rf /var/lib/apt/lists/* \
 && curl --fail --location --retry 5 --output /tmp/jadx.zip "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" \
 && echo "${JADX_SHA256}  /tmp/jadx.zip" | sha256sum --check --status \
 && mkdir -p /opt/jadx && unzip -q /tmp/jadx.zip -d /opt/jadx && rm /tmp/jadx.zip \
 && chmod -R a+rX /opt/jadx && apt-get purge -y --auto-remove curl unzip && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin jadx
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV JADX_HOME=/opt/jadx JADX_ZIP_MAX_ENTRIES_COUNT=100000 JADX_CONFIG_DIR=/tmp/jadx-config JADX_CACHE_DIR=/tmp/jadx-cache JADX_TMP_DIR=/tmp/jadx-tmp
EXPOSE 8010
ENTRYPOINT ["/app/entrypoint.sh"]
