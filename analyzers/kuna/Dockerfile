FROM debian:bookworm-slim

ARG TARGETARCH
ARG KUNA_VERSION=1.878
ARG KUNA_COMMIT=cb68db18fc8bbe5c117059bde45031c470c725dd
ARG KUNA_AMD64_SHA256=91a2baaf232fde882eb1c39dbb31448540887cba0b4ab38c753f67099e6df0f5
ARG KUNA_ARM64_SHA256=df4cf28543a329cc7df6601dbf473213b6b5f0865393a7cdc2de38ce37a6ac16

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl passwd python3 tar \
 && rm -rf /var/lib/apt/lists/* \
 && set -eux; \
    case "$TARGETARCH" in \
      amd64) asset_arch=x86_64; digest="$KUNA_AMD64_SHA256" ;; \
      arm64) asset_arch=arm64; digest="$KUNA_ARM64_SHA256" ;; \
      *) echo "Unsupported Kuna target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    archive="kuna-v${KUNA_VERSION}-linux-${asset_arch}.tar.gz"; \
    curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/Noelo-Lab/kuna/releases/download/v${KUNA_VERSION}/${archive}" -o "/tmp/${archive}"; \
    echo "${digest}  /tmp/${archive}" | sha256sum -c -; \
    mkdir -p /opt/kuna /licenses/kuna; \
    tar -xzf "/tmp/${archive}" --strip-components=1 -C /opt/kuna; \
    chmod 0555 /opt/kuna/kuna; \
    curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/Noelo-Lab/kuna/${KUNA_COMMIT}/LICENSE" -o /licenses/kuna/LICENSE; \
    curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/Noelo-Lab/kuna/${KUNA_COMMIT}/NOTICE" -o /licenses/kuna/NOTICE; \
    rm -f "/tmp/${archive}"; \
    useradd --system --uid 10003 --no-create-home --shell /usr/sbin/nologin kuna

WORKDIR /app
COPY server.py worker.py ./
RUN chmod 0555 /app/server.py /app/worker.py

ENV PATH="/opt/kuna:${PATH}" \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    KUNA_PROVIDER_REVISION="${KUNA_COMMIT}" \
    KUNA_VERSION="${KUNA_VERSION}"
EXPOSE 8025
USER 10003:10003
CMD ["python3", "/app/server.py"]
