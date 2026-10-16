FROM debian:trixie-slim AS build
ARG LUAJIT_DECOMPILER_COMMIT=0ec63c05acec3173cab868aca1de1f230d6c7b31
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \
 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/PackageInstaller/luajit-decompiler.git /src \
 && git -C /src checkout --detach "$LUAJIT_DECOMPILER_COMMIT" \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /build --parallel 2

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 python3 util-linux \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin luajit \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/luajit-decompiler /usr/local/bin/luajit-decompiler
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /usr/local/bin/luajit-decompiler /app/server.py /app/entrypoint.sh
EXPOSE 8016
ENTRYPOINT ["/app/entrypoint.sh"]
