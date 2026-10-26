# RedAmon Docker broker (V4)
#
# A filtering reverse proxy for the Docker Engine API. It mounts the REAL
# /var/run/docker.sock (it is a trusted component, like the orchestrator) and
# serves a RESTRICTED socket that the recon / partial-recon containers mount
# instead of the raw socket. It validates POST /containers/create so a
# compromised recon container cannot escape to the host (no -v /:/host, no
# --privileged, no non-allowlisted image). Stdlib-only — no dependencies.
FROM python:3.12-alpine

WORKDIR /app
COPY broker.py project_worker.py ./

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python3", "broker.py"]
