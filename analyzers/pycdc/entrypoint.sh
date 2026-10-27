#!/bin/sh
set -eu
mkdir -p /data/reamon-derived
chown 10001:10001 /data/reamon-derived
exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs sh -c 'mkdir -p /data/reamon-derived/.reamon-pycdc-output && exec python3 /app/server.py'
