FROM python:3.12-slim
ARG PYCDC_VERSION=0.6.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget util-linux \
 && set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="x86_64"; sha="169c5806b8247f2fa8bd2778c8172077dd4c4a040c69adc77222cd0c38568490" ;; \
      arm64) asset="aarch64"; sha="43b71b536e91b55714359c7ade6b241bafbb7d9a5384f8b0995b1351bf212e96" ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    wget -q "https://github.com/ejfkdev/pycdc/releases/download/v${PYCDC_VERSION}/pycdc-${asset}-linux" -O /usr/local/bin/pycdc; \
    echo "$sha  /usr/local/bin/pycdc" | sha256sum -c -; \
    chmod 0555 /usr/local/bin/pycdc; \
    useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin pycdc; \
    apt-get purge -y wget; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/server.py /app/entrypoint.sh
EXPOSE 8014
ENTRYPOINT ["/app/entrypoint.sh"]
