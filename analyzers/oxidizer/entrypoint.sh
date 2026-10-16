#!/bin/sh
set -eu
DERIVED="${REAMON_DERIVED_PATH:-/data/reamon-derived}"
mkdir -p "$DERIVED"
chown 10002:10002 "$DERIVED"
exec setpriv --reuid=10002 --regid=10002 --clear-groups --no-new-privs python3 /app/server.py
