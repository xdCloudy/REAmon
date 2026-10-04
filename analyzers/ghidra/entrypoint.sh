#!/bin/sh
set -eu
mkdir -p /data/reamon-derived
chown 10002:10002 /data/reamon-derived
exec setpriv --reuid=10002 --regid=10002 --clear-groups --no-new-privs python3 /app/server.py
