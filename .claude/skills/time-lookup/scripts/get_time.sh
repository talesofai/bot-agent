#!/usr/bin/env bash
set -euo pipefail

timezone="${1:-}"

if [[ -n "$timezone" ]]; then
  TZ="$timezone" date "+%Y-%m-%d %H:%M (%a, %Z)"
else
  date "+%Y-%m-%d %H:%M (%a, %Z)"
fi
