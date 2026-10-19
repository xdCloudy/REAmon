#!/bin/sh
set -eu
mkdir -p /data/reamon-derived
chown 10003:10003 /data/reamon-derived
exec setpriv --reuid=10003 --regid=10003 --clear-groups --no-new-privs python3 /app/server.py
