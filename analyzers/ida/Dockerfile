FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libgcc-s1 libstdc++6 libfontconfig1 libx11-6 libxext6 libxrender1 libxfixes3 libxcb1 libgl1 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10003 --no-create-home --shell /usr/sbin/nologin ida
WORKDIR /app
COPY server.py ./server.py
COPY ida-export.py ./ida-export.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/server.py /app/ida-export.py /app/entrypoint.sh
ENV PORT=8014
EXPOSE 8014
ENTRYPOINT ["/app/entrypoint.sh"]
