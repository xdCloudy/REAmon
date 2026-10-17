FROM ubuntu:focal AS builder

ARG RETDEC_COMMIT=9450585772e6f1c18e5f0b2ad5518a18d6bce71e

RUN useradd -m retdec \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git python3 doxygen graphviz upx openssl libssl-dev \
    zlib1g-dev autoconf automake pkg-config m4 libtool python-is-python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /home/retdec
USER retdec
RUN git clone https://github.com/avast/retdec.git \
 && cd retdec \
 && git checkout --detach "${RETDEC_COMMIT}" \
 && mkdir build \
 && cd build \
 && cmake .. -DCMAKE_INSTALL_PREFIX=/home/retdec/retdec-install -DCMAKE_LIBRARY_PATH=/usr/lib/gcc/x86_64-linux-gnu/9/ -DCMAKE_BUILD_TYPE=Release \
 && make -j2 \
 && make install

FROM ubuntu:focal

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin retdec \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl graphviz upx python3 util-linux \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /home/retdec
COPY --from=builder /home/retdec/retdec-install /retdec-install
COPY --from=builder /home/retdec/retdec/LICENSE /usr/share/licenses/retdec/LICENSE
COPY --from=builder /home/retdec/retdec/LICENSE-PELIB /usr/share/licenses/retdec/LICENSE-PELIB
COPY --from=builder /home/retdec/retdec/LICENSE-THIRD-PARTY /usr/share/licenses/retdec/LICENSE-THIRD-PARTY
ENV PATH=/retdec-install/bin:$PATH \
    REAMON_ARTIFACTS_PATH=/data/reamon-artifacts \
    REAMON_DERIVED_PATH=/data/reamon-derived \
    RETDEC_TIMEOUT_SECONDS=900 \
    RETDEC_MAX_OUTPUT_BYTES=268435456
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod 0555 /app/server.py /app/entrypoint.sh
EXPOSE 8023
ENTRYPOINT ["/app/entrypoint.sh"]
