FROM eclipse-temurin:21-jdk-jammy AS build
ARG UNLUAC_COMMIT=744c8149d93f7739f17b7f0f506822fb93ba7193
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/Jeong-Min-Cho/unluac.git /src \
 && git -C /src checkout --detach "$UNLUAC_COMMIT" \
 && mkdir -p /build/classes \
 && cd /src/src \
 && javac -d /build/classes unluac/Main.java \
 && jar cfm /build/unluac.jar /src/MANIFEST.MF -C /build/classes .

FROM eclipse-temurin:21-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin unluac \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/unluac.jar /opt/unluac.jar
WORKDIR /app
COPY server.py ./server.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0444 /opt/unluac.jar && chmod 0555 /app/server.py /app/entrypoint.sh
EXPOSE 8017
ENTRYPOINT ["/app/entrypoint.sh"]
