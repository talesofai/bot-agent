#!/bin/sh
set -e

force="false"
if [ "${1:-}" = "--force" ]; then
  force="true"
fi

copy_if_missing() {
  src="$1"
  dst="$2"
  if [ -f "$dst" ] && [ "$force" != "true" ]; then
    echo "Skip (exists): $dst"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "Wrote: $dst"
}

copy_if_missing "configs/secrets/.env.example" "configs/secrets/.env"
./scripts/generate-k8s-secret.sh

echo "Done. Edit configs/secrets/.env and re-run generate-k8s-secret.sh if needed."
