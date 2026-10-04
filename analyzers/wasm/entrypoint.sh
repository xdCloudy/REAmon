#!/bin/sh
set -eu
DERIVED="${REAMON_DERIVED_PATH:-/data/reamon-derived}"
mkdir -p "$DERIVED"
chown 10001:10001 "$DERIVED"
exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs python3 /app/server.py
