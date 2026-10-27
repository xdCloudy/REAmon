# RedAmon Supply-Chain Scan (artifact producer)
# ============================================
# Runs a static, no-install, OFFLINE osv-scanner pass over its input (plan S1).
# Graph writes are performed by the trusted orchestrator after run-ID validation.
#
# The input is either an operator-uploaded SBOM/lockfile or a GitHub repository
# it clones itself. It still NEVER downloads a tarball or runs a package
# manager: `git clone` writes files without executing repository code (remote
# hooks are not fetched, submodules and LFS smudge are disabled), and every
# step that PARSES untrusted content happens in the dirty analyzer. The clone
# lives here because this is the only side that may hold the GitHub token.
#
# supply_chain_common is volume-mounted at spawn time; the offline OSV DB is
# mounted read-only at /osv-db.

# osv-scanner v2.4.0 needs Go >= 1.26.4; build it here and COPY the binary.
FROM golang:1-bookworm AS osv-builder
RUN GOBIN=/out go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.4.0

FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# git is required by the GitHub repository input (supply_chain_scan/repo_clone.py).
# Without it the clone fails at runtime with "could not run git" and the scan
# reports an error instead of a result.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=osv-builder /out/osv-scanner /usr/local/bin/osv-scanner

COPY scanners/supply_chain_scan/requirements.txt /app/supply_chain_scan/requirements.txt
RUN pip install --no-cache-dir -r /app/supply_chain_scan/requirements.txt

COPY scanners/supply_chain_scan/ /app/supply_chain_scan/

# supply_chain_common is bind-mounted at /app/supply_chain_common by the
# orchestrator spawn (not baked here).

ENV PROJECT_ID="" USER_ID="" WEBAPP_API_URL=""

CMD ["python", "/app/supply_chain_scan/main.py"]
