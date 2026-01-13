#!/bin/sh
set -e

ENV_FILE="${ENV_FILE:-configs/secrets/.env}"
OUTPUT_FILE="${OUTPUT_FILE:-deployments/k8s/llbot-secret.yaml}"
SECRET_NAME="${SECRET_NAME:-llbot-secrets}"
NAMESPACE="${NAMESPACE:-bot}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

raw_token="$(sed -n 's/^[[:space:]]*WEBUI_TOKEN[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n 1)"
case "$raw_token" in
  \"*\") WEBUI_TOKEN="${raw_token#\"}"; WEBUI_TOKEN="${WEBUI_TOKEN%\"}" ;;
  \'*\') WEBUI_TOKEN="${raw_token#\'}"; WEBUI_TOKEN="${WEBUI_TOKEN%\'}" ;;
  *) WEBUI_TOKEN="$(printf "%s" "$raw_token" | sed 's/[[:space:]]#.*$//')" ;;
esac
WEBUI_TOKEN="$(printf "%s" "${WEBUI_TOKEN:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [ -z "$WEBUI_TOKEN" ]; then
  echo "WEBUI_TOKEN is required and cannot be empty in $ENV_FILE"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

{
  echo "apiVersion: v1"
  echo "kind: Secret"
  echo "metadata:"
  echo "  name: ${SECRET_NAME}"
  echo "  namespace: ${NAMESPACE}"
  echo "type: Opaque"
  echo "stringData:"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac
    case "$line" in
      *"="*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    val=${line#*=}
    key=$(printf "%s" "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    val=$(printf "%s" "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    esc=$(printf "%s" "$val" | sed 's/\\/\\\\/g; s/\"/\\\"/g')
    printf "  %s: \"%s\"\n" "$key" "$esc"
  done < "$ENV_FILE"
} > "$OUTPUT_FILE"

echo "Wrote: $OUTPUT_FILE"
