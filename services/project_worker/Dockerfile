# REAmon's isolated source-execution and terminal image.
# This image contains language runtimes and compilers, not the pentest toolset.
FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    NUGET_XMLDOC_MODE=skip

ARG REAMON_DOTNET_SDK_VERSION=10.0.402

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl file findutils git \
      gcc g++ make util-linux \
      default-jdk-headless golang-go nodejs npm perl python3-pip ruby rustc cargo \
      libicu-dev \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global typescript@5.7.3 \
    && rm -rf /root/.npm

RUN curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
      -o /tmp/dotnet-install.sh https://dot.net/v1/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --version "$REAMON_DOTNET_SDK_VERSION" --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && rm -rf /tmp/*

ENV DOTNET_ROOT=/usr/share/dotnet \
    HOME=/tmp \
    DOTNET_CLI_HOME=/tmp/.dotnet \
    PATH="/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

WORKDIR /workspace
USER 65534:65534
