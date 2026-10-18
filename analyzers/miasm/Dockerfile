FROM python:3.12-slim-bookworm

ARG MIASM_REVISION=3671fc24d6e625c2d75f3311724eb6b0c97664f8

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && git init /src/miasm \
 && git -C /src/miasm remote add origin https://github.com/cea-sec/miasm.git \
 && git -C /src/miasm fetch --depth 1 origin "${MIASM_REVISION}" \
 && git -C /src/miasm checkout --detach FETCH_HEAD \
 && test "$(git -C /src/miasm rev-parse HEAD)" = "${MIASM_REVISION}" \
 && pip install --no-cache-dir /src/miasm \
 && mkdir -p /licenses/miasm \
 && cp /src/miasm/LICENSE /licenses/miasm/LICENSE \
 && mkdir -p /usr/src \
 && mv /src/miasm /usr/src/miasm \
 && chmod -R a-w /usr/src/miasm \
 && apt-get purge -y --auto-remove git

RUN useradd --system --uid 10018 --no-create-home --shell /usr/sbin/nologin miasm \
 && mkdir -p /licenses/miasm /app

COPY server.py /app/server.py
RUN chmod 0555 /app/server.py

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    MIASM_VERSION=0.1.5 \
    MIASM_PROVIDER_REVISION=3671fc24d6e625c2d75f3311724eb6b0c97664f8

WORKDIR /app
EXPOSE 8034
USER 10018:10018
CMD ["python3", "/app/server.py"]
