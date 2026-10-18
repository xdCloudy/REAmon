FROM golang:1.24-alpine AS extractor-build
WORKDIR /src
COPY upstream/ ./
RUN mkdir -p /out && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/pyinstxtractor-go .

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PORT=8029
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin reamon \
 && mkdir -p /app \
 && chown 10001:10001 /app
WORKDIR /app
COPY --from=extractor-build --chown=10001:10001 /out/pyinstxtractor-go /usr/local/bin/pyinstxtractor-go
COPY --chown=10001:10001 server.py ./server.py
RUN chmod 0555 /usr/local/bin/pyinstxtractor-go /app/server.py
USER 10001:10001
EXPOSE 8029
ENTRYPOINT ["python3", "/app/server.py"]
