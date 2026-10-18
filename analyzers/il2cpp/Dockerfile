FROM mcr.microsoft.com/dotnet/sdk:8.0 AS il2cpp-build
ARG IL2CPPDUMPER_REVISION=8a521b9c180cf13499253f0818cbc729dca767cb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && git clone https://github.com/Perfare/Il2CppDumper.git /src/Il2CppDumper \
 && git -C /src/Il2CppDumper checkout "${IL2CPPDUMPER_REVISION}" \
 && test "$(git -C /src/Il2CppDumper rev-parse HEAD)" = "${IL2CPPDUMPER_REVISION}"
WORKDIR /src/Il2CppDumper/Il2CppDumper
RUN dotnet publish Il2CppDumper.csproj --configuration Release --framework net8.0 \
    -p:TargetFrameworks=net8.0 -p:TargetFramework=net8.0 \
    --output /opt/il2cpp-dumper --no-self-contained

FROM mcr.microsoft.com/dotnet/runtime:8.0
ARG IL2CPPDUMPER_REVISION=8a521b9c180cf13499253f0818cbc729dca767cb
ENV PYTHONDONTWRITEBYTECODE=1 PORT=8035 IL2CPP_DUMPER_HOME=/opt/il2cpp-dumper DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin il2cpp \
 && mkdir -p /app /usr/share/licenses/il2cppdumper \
 && chown 10001:10001 /app
COPY --from=il2cpp-build --chown=10001:10001 /opt/il2cpp-dumper/ /opt/il2cpp-dumper/
COPY --from=il2cpp-build /src/Il2CppDumper/LICENSE /usr/share/licenses/il2cppdumper/LICENSE
COPY --chown=10001:10001 server.py /app/server.py
RUN chmod -R a+rX /opt/il2cpp-dumper /usr/share/licenses/il2cppdumper \
 && chmod 0555 /app/server.py
USER 10001:10001
EXPOSE 8035
ENTRYPOINT ["python3", "/app/server.py"]
