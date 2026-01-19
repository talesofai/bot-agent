#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  check_url.sh [--image] <url> [url...]

Checks whether URL(s) are reachable from the current environment.

Exit codes:
  0  all URLs passed
  1  at least one URL failed
  2  invalid arguments

Options:
  --image    require Content-Type to be image/*

Environment:
  CHECK_URL_CONNECT_TIMEOUT  connect timeout seconds (default: 5)
  CHECK_URL_MAX_TIME         total timeout seconds (default: 10)
EOF
}

expect_image=0
if [[ "${1:-}" == "--image" ]]; then
  expect_image=1
  shift
fi

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 2
fi

connect_timeout="${CHECK_URL_CONNECT_TIMEOUT:-5}"
max_time="${CHECK_URL_MAX_TIME:-10}"

is_http_url() {
  case "$1" in
    http://*|https://*) return 0 ;;
    *) return 1 ;;
  esac
}

extract_last_header_value() {
  local header_name="$1"
  awk -v h="$header_name" 'BEGIN{IGNORECASE=1}
    $0 ~ "^" h ":" {v=$0}
    END{
      sub("^[^:]*:[[:space:]]*", "", v);
      gsub("\r", "", v);
      print v
    }'
}

check_one() {
  local url="$1"
  if ! is_http_url "$url"; then
    echo "FAIL url=$url reason=invalid_scheme"
    return 1
  fi

  local headers=""
  headers="$(curl -fsSIL --location --connect-timeout "$connect_timeout" --max-time "$max_time" "$url" 2>/dev/null || true)"
  if [[ -z "$headers" ]]; then
    headers="$(curl -fsSL --location --range 0-0 -D - -o /dev/null --connect-timeout "$connect_timeout" --max-time "$max_time" "$url" 2>/dev/null || true)"
  fi
  if [[ -z "$headers" ]]; then
    echo "FAIL url=$url reason=connect"
    return 1
  fi

  local status=""
  status="$(printf '%s\n' "$headers" | awk 'BEGIN{IGNORECASE=1} $1 ~ /^HTTP\\// {code=$2} END{print code}')"
  if [[ -z "$status" ]]; then
    echo "FAIL url=$url reason=no_status"
    return 1
  fi

  if [[ "$status" -lt 200 || "$status" -ge 400 ]]; then
    echo "FAIL url=$url status=$status"
    return 1
  fi

  local content_type=""
  content_type="$(printf '%s\n' "$headers" | extract_last_header_value "content-type" | tr '[:upper:]' '[:lower:]' | awk '{print $1}')"

  if [[ "$expect_image" -eq 1 ]]; then
    if [[ -z "$content_type" || "$content_type" != image/* ]]; then
      echo "FAIL url=$url status=$status content_type=${content_type:-<empty>}"
      return 1
    fi
  fi

  echo "OK url=$url status=$status content_type=${content_type:-<empty>}"
  return 0
}

overall=0
for url in "$@"; do
  if ! check_one "$url"; then
    overall=1
  fi
done

exit "$overall"

