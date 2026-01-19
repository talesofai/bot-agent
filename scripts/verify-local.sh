#!/bin/sh
set -e

if [ -z "${WEBUI_TOKEN:-}" ] && [ -f "configs/.env" ]; then
  raw_token="$(sed -n 's/^WEBUI_TOKEN=//p' configs/.env | tail -n 1)"
  raw_token="$(printf "%s" "$raw_token" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$raw_token" in
    \"*\") WEBUI_TOKEN="${raw_token#\"}"; WEBUI_TOKEN="${WEBUI_TOKEN%\"}" ;;
    \'*\') WEBUI_TOKEN="${raw_token#\'}"; WEBUI_TOKEN="${WEBUI_TOKEN%\'}" ;;
    *) WEBUI_TOKEN="$(printf "%s" "$raw_token" | sed 's/[[:space:]]#.*$//')" ;;
  esac
fi
WEBUI_TOKEN="${WEBUI_TOKEN:-change-me}"

hash_token() {
  if command -v shasum >/dev/null 2>&1; then
    printf "%s" "$WEBUI_TOKEN" | shasum -a 256 | awk '{print $1}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    printf "%s" "$WEBUI_TOKEN" | openssl dgst -sha256 | awk '{print $2}'
    return
  fi
  echo "Missing shasum/openssl for SHA-256 hashing."
  exit 1
}

echo "Checking WebUI..."
curl -fsSL -o /dev/null -w "WebUI HTTP: %{http_code}\n" http://localhost:3080

echo "Checking login QR API..."
HASH="$(hash_token)"
curl -fsSL "http://localhost:3080/api/login-qrcode?token=${HASH}" | head -c 200
echo

echo "Checking Milky TCP port..."
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 2 127.0.0.1 3000 >/dev/null 2>&1; then
    echo "Milky TCP: open"
  else
    echo "Milky TCP: closed"
    exit 1
  fi
else
  echo "Missing nc for TCP check."
  exit 1
fi
