FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar util-linux \
 && curl --fail --location --retry 5 -o /tmp/wabt.tar.gz https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-linux-x64.tar.gz \
 && echo "84895407a6bbb80e918f33b16b2fb2206021c150b6bc9ff6f761263a745ab131  /tmp/wabt.tar.gz" | sha256sum --check --status \
 && mkdir -p /opt/wabt/bin && tar -xzf /tmp/wabt.tar.gz --strip-components=2 -C /opt/wabt/bin wabt-1.0.42/bin/wasm2wat \
 && rm /tmp/wabt.tar.gz && apt-get purge -y --auto-remove curl && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin wasm
WORKDIR /app
COPY server.py /app/server.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 0555 /app/server.py /app/entrypoint.sh /opt/wabt/bin/wasm2wat
EXPOSE 8012
ENTRYPOINT ["/app/entrypoint.sh"]
