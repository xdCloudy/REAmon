FROM python:3.12-slim
ARG CFR_VERSION=0.152
ARG CFR_SHA256=f686e8f3ded377d7bc87d216a90e9e9512df4156e75b06c655a16648ae8765b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jre-headless util-linux \
 && curl --fail --location --retry 5 --output /opt-cfr.jar "https://github.com/leibnitz27/cfr/releases/download/${CFR_VERSION}/cfr-${CFR_VERSION}.jar" \
 && echo "${CFR_SHA256}  /opt-cfr.jar" | sha256sum --check --status \
 && mkdir -p /opt/cfr && mv /opt-cfr.jar /opt/cfr/cfr.jar \
 && chmod 0444 /opt/cfr/cfr.jar \
 && apt-get purge -y --auto-remove curl && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin cfr
COPY CFR_LICENSE.md /usr/share/licenses/cfr/LICENSE.md
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    CFR_TIMEOUT_SECONDS=900 \
    CFR_MAX_OUTPUT_BYTES=536870912 \
    CFR_MAX_SOURCE_FILES=20000
EXPOSE 8022
ENTRYPOINT ["/app/entrypoint.sh"]
