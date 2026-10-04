FROM python:3.12-slim
ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_BUILD=20260921
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jdk-headless unzip util-linux && rm -rf /var/lib/apt/lists/* \
 && curl --fail --location --retry 5 --output /tmp/ghidra.zip "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip" \
 && echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum --check --status \
 && mkdir -p /opt/ghidra && unzip -q /tmp/ghidra.zip -d /opt/ghidra && rm /tmp/ghidra.zip \
 && mv /opt/ghidra/ghidra_${GHIDRA_VERSION}_PUBLIC /opt/ghidra/current \
 && chmod -R a+rX /opt/ghidra && apt-get purge -y --auto-remove curl unzip \
 && useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin ghidra
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
COPY ReamonExport.java ./scripts/ReamonExport.java
RUN chmod 0555 /app/server.py /app/entrypoint.sh /app/scripts/ReamonExport.java
ENV GHIDRA_HOME=/opt/ghidra/current GHIDRA_INSTALL_DIR=/opt/ghidra/current JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
EXPOSE 8011
ENTRYPOINT ["/app/entrypoint.sh"]
