#!/usr/bin/env bash
# REAmon lifecycle entrypoint. Reviewed releases are installed from this
# repository; the runtime never performs remote update checks.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/redamon.sh" "$@"
