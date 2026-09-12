#!/bin/sh
# PrivateDrop entrypoint: fix ownership of the storage volume on first
# upgraded start, then drop privileges and run as the unprivileged app user.
set -e

APP_DIR="${APP_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
    if [ -d "$APP_DIR" ]; then
        chown -R app:app "$APP_DIR" 2>/dev/null || true
    fi
    exec su-exec app:app "$@"
fi

exec "$@"
