#!/bin/sh
set -e

ENV_FILE="$1"

cat > "$ENV_FILE" << EOF
window.__MAUSVOICE__ = {
  MAUSVOICE_GATEWAY_URL: "${MAUSVOICE_GATEWAY_URL:-}",
  MAUSVOICE_APP_NAME: "${MAUSVOICE_APP_NAME:-}",
};
EOF

shift
exec "$@"
