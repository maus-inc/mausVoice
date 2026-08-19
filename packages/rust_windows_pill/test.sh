#!/usr/bin/env bash
set -euo pipefail
PILL_CRATE_DIR="$(cd "$(dirname "$0")" && pwd)"
export PILL_CRATE_DIR
exec "$(dirname "$0")/../rust_pill_shared/test.sh" "$@"
