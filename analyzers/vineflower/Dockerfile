FROM python:3.12-slim
ARG VINEFLOWER_VERSION=1.12.0
ARG VINEFLOWER_SHA256=1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jre-headless util-linux \
 && curl --fail --location --retry 5 --output /opt-vineflower.jar "https://github.com/Vineflower/vineflower/releases/download/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar" \
 && echo "${VINEFLOWER_SHA256}  /opt-vineflower.jar" | sha256sum --check --status \
 && mkdir -p /opt/vineflower && mv /opt-vineflower.jar /opt/vineflower/vineflower.jar \
 && chmod 0444 /opt/vineflower/vineflower.jar \
 && apt-get purge -y --auto-remove curl && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin vineflower
COPY VINEFLOWER_LICENSE.md /usr/share/licenses/vineflower/LICENSE.md
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    VINEFLOWER_TIMEOUT_SECONDS=900 \
    VINEFLOWER_MAX_OUTPUT_BYTES=536870912 \
    VINEFLOWER_MAX_SOURCE_FILES=20000
EXPOSE 8021
ENTRYPOINT ["/app/entrypoint.sh"]
