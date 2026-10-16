#!/bin/sh
set -eu
mkdir -p /data/reamon-derived
chown 10001:10001 /data/reamon-derived
exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs python3 /app/server.py
