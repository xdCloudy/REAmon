FROM mcr.microsoft.com/dotnet/runtime:8.0

ARG REKO_VERSION=0.12.5
ARG REKO_REVISION=418d3538ee87f46e87b80b5b8b93138f63952497
ARG REKO_CLI_SHA256=26a0705ed12928d4c0543e2f2c1846fe293220df66ddb41e922afa7c6a4ff9fe

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_CLI_HOME=/tmp/dotnet
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 unzip \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/reko /usr/share/licenses/reko /tmp/reko-src \
 && curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/uxmal/reko/releases/download/version-${REKO_VERSION}/CmdLine-${REKO_VERSION}-x64-418d3538ee.zip" -o /tmp/reko.zip \
 && echo "${REKO_CLI_SHA256}  /tmp/reko.zip" | sha256sum -c - \
 && unzip -q /tmp/reko.zip -d /opt/reko \
 && curl --proto '=https' --tlsv1.2 -fsSL "https://codeload.github.com/uxmal/reko/tar.gz/${REKO_REVISION}" -o /tmp/reko-source.tar.gz \
 && tar -xzf /tmp/reko-source.tar.gz --strip-components=1 -C /tmp/reko-src \
 && cp /tmp/reko-src/COPYING /usr/share/licenses/reko/COPYING \
 && cp /tmp/reko-source.tar.gz /usr/share/licenses/reko/reko-${REKO_REVISION}-source.tar.gz \
 && rm -rf /tmp/reko.zip /tmp/reko-source.tar.gz /tmp/reko-src \
 && useradd --system --uid 10011 --no-create-home --shell /usr/sbin/nologin reko

WORKDIR /app
COPY server.py ./server.py
RUN chmod 0555 /app/server.py

ENV REKO_BIN=/opt/reko/decompile.dll REKO_VERSION=0.12.5 REKO_PROVIDER_REVISION=418d3538ee87f46e87b80b5b8b93138f63952497 HOME=/tmp XDG_CACHE_HOME=/tmp PYTHONDONTWRITEBYTECODE=1
EXPOSE 8031
USER 10011:10011
CMD ["python3", "/app/server.py"]
