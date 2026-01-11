#!/bin/sh
set -e

if [ -z "${WEBUI_TOKEN:-}" ]; then
  echo "WEBUI_TOKEN is required. Example: WEBUI_TOKEN=your-token ./scripts/rotate-secrets.sh"
  exit 1
fi

write_env() {
  file="configs/secrets/.env"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ]; then
    if rg --quiet "^WEBUI_TOKEN=" "$file"; then
      sed -i.bak "s/^WEBUI_TOKEN=.*/WEBUI_TOKEN=${WEBUI_TOKEN}/" "$file"
      rm -f "${file}.bak"
    else
      printf "\nWEBUI_TOKEN=%s\n" "$WEBUI_TOKEN" >> "$file"
    fi
  else
    cp "configs/secrets/.env.example" "$file"
    printf "\nWEBUI_TOKEN=%s\n" "$WEBUI_TOKEN" >> "$file"
  fi
}

write_k8s_secret() {
  ./scripts/generate-k8s-secret.sh
}

write_env
write_k8s_secret

echo "Updated:"
echo "  configs/secrets/.env"
echo "  deployments/k8s/llbot-secret.yaml"
