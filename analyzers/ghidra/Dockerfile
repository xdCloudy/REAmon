FROM golang:1.25-bookworm AS goresym-build
ARG GORESYM_COMMIT=722897e0a80da0a06c00c5e40591a253a551f04e
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --filter=blob:none https://github.com/mandiant/GoReSym.git /src/GoReSym \
 && git -C /src/GoReSym checkout --detach "${GORESYM_COMMIT}" \
 && cd /src/GoReSym \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /goresym .

FROM rust:1.85-bookworm AS unstrip-build
ARG UNSTRIP_VERSION=1.2.0
RUN cargo install --locked --version "${UNSTRIP_VERSION}" unstrip \
 && mkdir -p /unstrip-licenses \
 && cp /usr/local/cargo/registry/src/index.crates.io-*/unstrip-${UNSTRIP_VERSION}/LICENSE-* /unstrip-licenses/

FROM rust:1.90-bookworm AS reipa-build
ARG REIPA_COMMIT=b0d4759451ed20796892a059fa53d9dbb130af61
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --filter=blob:none https://github.com/JRBusiness/REipa.git /src/reipa \
 && git -C /src/reipa checkout --detach "${REIPA_COMMIT}"
COPY reipa-Cargo.lock /src/reipa/reipa/Cargo.lock
RUN cd /src/reipa/reipa && cargo build --release --locked --bin reipa

FROM python:3.12-slim
ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_BUILD=20260921
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
ARG FLOSS_VERSION=3.1.1
ARG FLOSS_SHA256=40c05a869f34f7e2417b17ca290cc54bd3671ee1f0a2d9bd5103284c01a54666
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jdk-headless unzip util-linux && rm -rf /var/lib/apt/lists/* \
 && curl --fail --location --retry 5 --output /tmp/ghidra.zip "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip" \
 && echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum --check --status \
 && mkdir -p /opt/ghidra && unzip -q /tmp/ghidra.zip -d /opt/ghidra && rm /tmp/ghidra.zip \
 && mv /opt/ghidra/ghidra_${GHIDRA_VERSION}_PUBLIC /opt/ghidra/current \
 && if [ "${TARGETARCH}" = "amd64" ]; then \
      curl --fail --location --retry 5 --output /tmp/floss.zip "https://github.com/mandiant/flare-floss/releases/download/v${FLOSS_VERSION}/floss-v${FLOSS_VERSION}-linux.zip" \
      && echo "${FLOSS_SHA256}  /tmp/floss.zip" | sha256sum --check --status \
      && unzip -q /tmp/floss.zip floss -d /tmp/floss-release \
      && install -D -m 0555 /tmp/floss-release/floss /usr/local/bin/floss \
      && curl --fail --location --retry 5 --output /tmp/floss-license.txt "https://raw.githubusercontent.com/mandiant/flare-floss/v${FLOSS_VERSION}/LICENSE.txt" \
      && echo "787008a875d16021fa995a81553a98e481b938ece1f2e8a1910daf8dffaf1300  /tmp/floss-license.txt" | sha256sum --check --status \
      && install -D -m 0444 /tmp/floss-license.txt /usr/share/licenses/floss/LICENSE.txt \
      && rm -rf /tmp/floss.zip /tmp/floss-release /tmp/floss-license.txt; \
    else echo "FLOSS standalone v${FLOSS_VERSION} is only installed for amd64; the analyzer will report it unavailable on ${TARGETARCH}"; fi \
 && chmod -R a+rX /opt/ghidra && apt-get purge -y --auto-remove curl unzip \
 && useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin ghidra
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
COPY ReamonExport.java ./scripts/ReamonExport.java
COPY --from=goresym-build /goresym /usr/local/bin/goresym
COPY --from=goresym-build /src/GoReSym/LICENSE /usr/share/licenses/goresym/LICENSE
COPY --from=unstrip-build /usr/local/cargo/bin/unstrip /usr/local/bin/unstrip
COPY --from=unstrip-build /unstrip-licenses/ /usr/share/licenses/unstrip/
COPY --from=reipa-build /src/reipa/reipa/target/release/reipa /usr/local/bin/reipa
COPY --from=reipa-build /src/reipa/LICENSE /usr/share/licenses/reipa/LICENSE
RUN chmod 0555 /app/server.py /app/entrypoint.sh /app/scripts/ReamonExport.java
ENV GHIDRA_HOME=/opt/ghidra/current GHIDRA_INSTALL_DIR=/opt/ghidra/current JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
EXPOSE 8011
ENTRYPOINT ["/app/entrypoint.sh"]
