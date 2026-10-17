FROM ubuntu:24.04

ARG TARGETARCH
ARG FISSION_VERSION=0.2.3
ARG FISSION_SHA256=d8ef5d1a72cdcdbaf585b49fc260af2dff72ef58fbcc0b9cff09f09687aca955
ARG FISSION_COMMIT=1ea2b858358b5398e920e7caa34201524b538c87

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl passwd python3 tar \
 && rm -rf /var/lib/apt/lists/* \
 && test "$TARGETARCH" = "amd64" \
 && archive="fission-linux-x64.tar.gz" \
 && curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/fission-systems/Fission/releases/download/v${FISSION_VERSION}/${archive}" -o "/tmp/${archive}" \
 && echo "${FISSION_SHA256}  /tmp/${archive}" | sha256sum -c - \
 && mkdir -p /opt/fission /licenses/fission \
 && tar -xzf "/tmp/${archive}" --no-same-owner -C /opt/fission \
 && chmod 0555 /opt/fission/fission_cli \
 && curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/fission-systems/Fission/${FISSION_COMMIT}/LICENSE" -o /licenses/fission/LICENSE \
 && rm -f "/tmp/${archive}" \
 && useradd --system --uid 10007 --no-create-home --shell /usr/sbin/nologin fission

WORKDIR /app
COPY server.py worker.py ./
RUN chmod 0555 /app/server.py /app/worker.py

ENV PATH="/opt/fission:${PATH}" \
    FISSION_BIN=/opt/fission/fission_cli \
    FISSION_RESOURCE_ROOT=/opt/fission/utils \
    FISSION_VERSION=0.2.3 \
    FISSION_PROVIDER_REVISION=1ea2b858358b5398e920e7caa34201524b538c87 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8027
USER 10007:10007
CMD ["python3", "/app/server.py"]
