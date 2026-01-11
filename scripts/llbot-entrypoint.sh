#!/bin/sh
set -e

CONFIG_DIR="/config"
SRC_CONFIG="${CONFIG_DIR}/default_config.json"
DEST_CONFIG="/app/llbot/default_config.json"
TOKEN_FILE="/app/llbot/data/webui_token.txt"

if [ -f "$SRC_CONFIG" ]; then
  cp "$SRC_CONFIG" "$DEST_CONFIG"
fi

if [ -n "${WEBUI_TOKEN:-}" ]; then
  mkdir -p "/app/llbot/data"
  printf "%s" "$WEBUI_TOKEN" > "$TOKEN_FILE"
fi

exec /startup.sh
