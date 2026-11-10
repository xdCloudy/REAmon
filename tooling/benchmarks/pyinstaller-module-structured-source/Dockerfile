FROM python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0

WORKDIR /fixture
ENV SOURCE_DATE_EPOCH=1767225600
ENV PYTHONHASHSEED=0
RUN apt-get update \
 && apt-get install --yes --no-install-recommends binutils=2.40-2 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --requirement requirements.txt
COPY build_fixture.py ./build_fixture.py
RUN python build_fixture.py --output /out/pyinstaller-module-structured-source --work-root /tmp/reamon-pyi-structured-build

ENTRYPOINT ["/bin/sh", "-c", "cp /out/pyinstaller-module-structured-source /export/pyinstaller-module-structured-source && sha256sum /export/pyinstaller-module-structured-source"]
