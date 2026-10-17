FROM mcr.microsoft.com/dotnet/sdk:10.0 AS nofuserex-build
ARG NOFUSEREX_REVISION=bbdde27a817cf9b2ab9f03207fc3bd9adb7c8ff4
RUN apt-get update && apt-get install -y --no-install-recommends git mono-devel ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --recurse-submodules https://github.com/undebel/NoFuserEx.git /src/nofuserex \
    && git -C /src/nofuserex checkout "${NOFUSEREX_REVISION}" \
    && git -C /src/nofuserex submodule update --init --recursive \
    && xbuild /src/nofuserex/NoFuserEx/NoFuserEx/NoFuserEx.csproj /p:Configuration=Release /verbosity:minimal

FROM mcr.microsoft.com/dotnet/sdk:10.0
ARG ILSPYCMD_VERSION=11.1.0.9782
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_CLI_HOME=/tmp/dotnet
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 util-linux mono-runtime \
    && rm -rf /var/lib/apt/lists/* \
    && dotnet tool install --tool-path /opt/ilspycmd ilspycmd --version "${ILSPYCMD_VERSION}" \
    && chmod -R a+rX /opt/ilspycmd \
    && mkdir -p /opt/nofuserex /usr/share/licenses/nofuserex \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ilspy
COPY --from=nofuserex-build /src/nofuserex/NoFuserEx/NoFuserEx/bin/Release/NoFuserEx.exe /opt/nofuserex/NoFuserEx.exe
COPY --from=nofuserex-build /src/nofuserex/NoFuserEx/NoFuserEx/bin/Release/dnlib.dll /opt/nofuserex/dnlib.dll
COPY --from=nofuserex-build /src/nofuserex/LICENSE /usr/share/licenses/nofuserex/LICENSE
COPY --from=nofuserex-build /src/nofuserex/dnlib/LICENSE.txt /usr/share/licenses/nofuserex/dnlib-LICENSE.txt
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/server.py /app/entrypoint.sh
ENV ILSPYCMD=/opt/ilspycmd/ilspycmd ILSPY_VERSION=${ILSPYCMD_VERSION} NOFUSEREX=/opt/nofuserex/NoFuserEx.exe NOFUSEREX_VERSION=bbdde27a817cf9b2ab9f03207fc3bd9adb7c8ff4
EXPOSE 8013
ENTRYPOINT ["/app/entrypoint.sh"]
