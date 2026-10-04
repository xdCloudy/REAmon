FROM mcr.microsoft.com/dotnet/sdk:10.0
ARG ILSPYCMD_VERSION=11.1.0.9782
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_CLI_HOME=/tmp/dotnet
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && dotnet tool install --tool-path /opt/ilspycmd ilspycmd --version "${ILSPYCMD_VERSION}" \
    && chmod -R a+rX /opt/ilspycmd \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ilspy
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV ILSPYCMD=/opt/ilspycmd/ilspycmd ILSPY_VERSION=${ILSPYCMD_VERSION}
EXPOSE 8013
ENTRYPOINT ["/app/entrypoint.sh"]
