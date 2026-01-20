#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  search_images.sh "<query>" [--limit N] [--min-short-side N]

Search images via Bing and output verified Markdown images:
  ![desc](direct-image-url)

Options:
  --limit N           max images to output (default: 2)
  --min-short-side N  require min(width,height) >= N (default: 768)

Exit codes:
  0  found at least one verified image
  1  no verified image found
  2  invalid arguments
EOF
}

limit=2
min_short_side="${BING_IMAGE_MIN_SHORT_SIDE:-768}"

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 2
fi

query="${1:-}"
shift || true

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --limit)
      limit="${2:-}"
      shift 2
      ;;
    --min-short-side)
      min_short_side="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 2
      ;;
    --*)
      echo "FAIL reason=unknown_option option=$1"
      usage
      exit 2
      ;;
    *)
      echo "FAIL reason=unexpected_arg arg=$1"
      usage
      exit 2
      ;;
  esac
done

is_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

if ! is_non_negative_int "$limit" || [[ "$limit" -lt 1 ]]; then
  echo "FAIL reason=invalid_limit value=$limit"
  exit 2
fi
if ! is_non_negative_int "$min_short_side" || [[ "$min_short_side" -lt 1 ]]; then
  echo "FAIL reason=invalid_min_short_side value=$min_short_side"
  exit 2
fi

query="$(printf '%s' "$query" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$query" ]]; then
  echo "FAIL reason=empty_query"
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

find_workspace_root() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.claude/skills/url-access-check/scripts/check_url.sh" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

workspace_root="$(find_workspace_root || true)"
if [[ -z "$workspace_root" ]]; then
  echo "FAIL reason=missing_skills_dir detail=.claude/skills/url-access-check/scripts/check_url.sh"
  exit 1
fi

url_check="$workspace_root/.claude/skills/url-access-check/scripts/check_url.sh"

tmp_err="$(mktemp)"
candidate_lines=""
if ! candidate_lines="$(bun "$script_dir/search_images.mjs" --query "$query" --max-results 40 2>"$tmp_err")"; then
  detail="$(head -c 300 "$tmp_err" | tr '\n' ' ' | tr '\t' ' ')"
  rm -f "$tmp_err" || true
  echo "FAIL reason=search_error query=$query detail=${detail:-<empty>}"
  exit 1
fi
rm -f "$tmp_err" || true

if [[ -z "$candidate_lines" ]]; then
  echo "FAIL reason=no_candidates query=$query"
  exit 1
fi

count=0
declare -A seen=()
while IFS= read -r url; do
  url="${url:-}"
  if [[ -z "$url" ]]; then
    continue
  fi
  if [[ -n "${seen[$url]:-}" ]]; then
    continue
  fi
  seen["$url"]=1

  if bash "$url_check" --image --min-short-side "$min_short_side" "$url" >/dev/null 2>&1; then
    basename="$(printf '%s' "$url" | sed -E 's#^[a-zA-Z]+://##' | sed -E 's#[/?].*$##')"
    if [[ -z "$basename" ]]; then
      basename="image"
    fi
    printf '![%s](%s)\n' "$basename" "$url"
    count=$((count + 1))
    if [[ "$count" -ge "$limit" ]]; then
      break
    fi
  fi
done <<<"$candidate_lines"

if [[ "$count" -lt 1 ]]; then
  echo "FAIL reason=no_verified_images query=$query"
  exit 1
fi

exit 0

