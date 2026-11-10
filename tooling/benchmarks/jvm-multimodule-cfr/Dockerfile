FROM eclipse-temurin:21-jdk-jammy@sha256:4b1a74fbffbe6b4e7b6f0171a472478282fb463790a51edf10e465d578f22b69
WORKDIR /build
COPY src/ ./src/
RUN mkdir -p /classes \
 && javac --release 17 -d /classes $(find src -name '*.java' -type f | sort) \
 && jar --create --file /fixture.jar --date=2026-01-01T00:00:00Z --main-class org.reamon.fixture.Main -C /classes .
