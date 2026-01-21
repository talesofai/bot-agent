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
  --min-bytes N         require Content-Length (or downloaded bytes) >= N
  --min-width N         require image width >= N
  --min-height N        require image height >= N
  --min-short-side N    require min(width,height) >= N

Environment:
  CHECK_URL_CONNECT_TIMEOUT  connect timeout seconds (default: 10)
  CHECK_URL_MAX_TIME         total timeout seconds (default: 15)
  CHECK_URL_MAX_BYTES        max bytes to download for image inspection (default: 1048576)
  CHECK_IMAGE_MIN_BYTES      default minimum bytes for --image (default: 0)
  CHECK_IMAGE_MIN_SHORT_SIDE default minimum short side for --image (default: 768)
EOF
}

expect_image=0
min_bytes=""
min_width=""
min_height=""
min_short_side=""
if [[ "${1:-}" == "--image" ]]; then
  expect_image=1
  shift
fi

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --min-bytes)
      min_bytes="${2:-}"
      shift 2
      ;;
    --min-width)
      min_width="${2:-}"
      shift 2
      ;;
    --min-height)
      min_height="${2:-}"
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
      break
      ;;
  esac
done

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 2
fi

connect_timeout="${CHECK_URL_CONNECT_TIMEOUT:-10}"
max_time="${CHECK_URL_MAX_TIME:-15}"
max_bytes="${CHECK_URL_MAX_BYTES:-1048576}"
ssrf_max_redirects="${SSRF_MAX_REDIRECTS:-3}"
user_agent="${CHECK_URL_USER_AGENT:-Mozilla/5.0 (compatible; opencode-bot-agent/1.0; +https://github.com/opencode-ai/opencode)}"
accept_header="${CHECK_URL_ACCEPT_HEADER:-image/*,*/*;q=0.8}"
curl_headers=(-H "user-agent: ${user_agent}" -H "accept: ${accept_header}")

default_min_bytes="${CHECK_IMAGE_MIN_BYTES:-0}"
default_min_short_side="${CHECK_IMAGE_MIN_SHORT_SIDE:-768}"

is_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

min_bytes="${min_bytes:-$default_min_bytes}"
min_short_side="${min_short_side:-$default_min_short_side}"

if ! is_non_negative_int "$max_bytes" || [[ "$max_bytes" -lt 1 ]]; then
  echo "FAIL reason=invalid_max_bytes value=$max_bytes"
  exit 2
fi
if ! is_non_negative_int "$ssrf_max_redirects"; then
  echo "FAIL reason=invalid_ssrf_max_redirects value=$ssrf_max_redirects"
  exit 2
fi

if [[ -n "$min_bytes" ]] && ! is_non_negative_int "$min_bytes"; then
  echo "FAIL reason=invalid_min_bytes value=$min_bytes"
  exit 2
fi
if [[ -n "$min_width" ]] && ! is_non_negative_int "$min_width"; then
  echo "FAIL reason=invalid_min_width value=$min_width"
  exit 2
fi
if [[ -n "$min_height" ]] && ! is_non_negative_int "$min_height"; then
  echo "FAIL reason=invalid_min_height value=$min_height"
  exit 2
fi
if [[ -n "$min_short_side" ]] && ! is_non_negative_int "$min_short_side"; then
  echo "FAIL reason=invalid_min_short_side value=$min_short_side"
  exit 2
fi

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

extract_hostname() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://([^/]+)/?.*$#\1#'
}

is_rejected_thumbnail_host() {
  case "$1" in
    encrypted-tbn*.gstatic.com|tbn*.gstatic.com) return 0 ;;
    *) return 1 ;;
  esac
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

resolve_redirect_url() {
  local base="$1"
  local location="$2"
  local output=""
  local code=0
  set +e
  output="$(bun "$script_dir/resolve_url.mjs" "$base" "$location" 2>/dev/null)"
  code=$?
  set -e
  if [[ "$code" -ne 0 || -z "$output" ]]; then
    return 1
  fi
  printf '%s' "$output"
  return 0
}

ssrf_check_url() {
  local url="$1"
  local output=""
  local code=0
  set +e
  output="$(bun "$script_dir/ssrf_guard.mjs" "$url" 2>/dev/null)"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    return 0
  fi
  output="$(printf '%s' "$output" | tr -d '\r\n')"
  if [[ -z "$output" ]]; then
    output="ssrf_blocked"
  fi
  printf '%s' "$output"
  return 1
}

fetch_headers_no_redirect() {
  local url="$1"
  local headers=""
  headers="$(curl -fsSIL --compressed --connect-timeout "$connect_timeout" --max-time "$max_time" "${curl_headers[@]}" "$url" 2>/dev/null || true)"
  if [[ -n "$headers" ]]; then
    printf '%s\n' "$headers"
    return 0
  fi
  headers="$(curl -fsSL --compressed --range 0-0 -D - -o /dev/null --connect-timeout "$connect_timeout" --max-time "$max_time" "${curl_headers[@]}" "$url" 2>/dev/null || true)"
  if [[ -n "$headers" ]]; then
    printf '%s\n' "$headers"
    return 0
  fi
  return 1
}

check_one() {
  local url="$1"
  local width=""
  local height=""
  if ! is_http_url "$url"; then
    echo "FAIL url=$url reason=invalid_scheme"
    return 1
  fi

  local current_url="$url"
  local redirects=0
  local headers=""
  local status=""
  local effective_url="$url"
  local location=""

  while true; do
    local ssrf_reason=""
    if ! ssrf_reason="$(ssrf_check_url "$current_url")"; then
      local suffix=""
      if [[ "$current_url" != "$url" ]]; then
        suffix=" effective_url=$current_url"
      fi
      echo "FAIL url=$url$suffix reason=ssrf_${ssrf_reason}"
      return 1
    fi

    if ! headers="$(fetch_headers_no_redirect "$current_url")"; then
      local suffix=""
      if [[ "$current_url" != "$url" ]]; then
        suffix=" effective_url=$current_url"
      fi
      echo "FAIL url=$url$suffix reason=connect"
      return 1
    fi

    status="$(printf '%s\n' "$headers" | awk 'BEGIN{IGNORECASE=1} $1 ~ /^HTTP\// {code=$2} END{print code}')"
    if [[ -z "$status" ]]; then
      local suffix=""
      if [[ "$current_url" != "$url" ]]; then
        suffix=" effective_url=$current_url"
      fi
      echo "FAIL url=$url$suffix reason=no_status"
      return 1
    fi

    if [[ "$status" -ge 300 && "$status" -lt 400 ]]; then
      location="$(printf '%s\n' "$headers" | extract_last_header_value "location" | tr -d '\r')"
      if [[ -z "$location" ]]; then
        local suffix=""
        if [[ "$current_url" != "$url" ]]; then
          suffix=" effective_url=$current_url"
        fi
        echo "FAIL url=$url$suffix status=$status reason=redirect_no_location"
        return 1
      fi
      if [[ "$redirects" -ge "$ssrf_max_redirects" ]]; then
        local suffix=""
        if [[ "$current_url" != "$url" ]]; then
          suffix=" effective_url=$current_url"
        fi
        echo "FAIL url=$url$suffix status=$status reason=too_many_redirects max_redirects=$ssrf_max_redirects"
        return 1
      fi
      local next_url=""
      if ! next_url="$(resolve_redirect_url "$current_url" "$location")"; then
        local suffix=""
        if [[ "$current_url" != "$url" ]]; then
          suffix=" effective_url=$current_url"
        fi
        echo "FAIL url=$url$suffix status=$status reason=invalid_redirect"
        return 1
      fi
      if ! is_http_url "$next_url"; then
        local suffix=""
        if [[ "$current_url" != "$url" ]]; then
          suffix=" effective_url=$current_url"
        fi
        echo "FAIL url=$url$suffix status=$status reason=invalid_redirect_scheme redirect_url=$next_url"
        return 1
      fi
      current_url="$next_url"
      redirects=$((redirects+1))
      continue
    fi

    effective_url="$current_url"
    break
  done

  if [[ "$status" -lt 200 || "$status" -ge 400 ]]; then
    local suffix=""
    if [[ "$effective_url" != "$url" ]]; then
      suffix=" effective_url=$effective_url"
    fi
    echo "FAIL url=$url$suffix status=$status"
    return 1
  fi

  local content_type=""
  content_type="$(printf '%s\n' "$headers" | extract_last_header_value "content-type" | tr '[:upper:]' '[:lower:]' | awk '{print $1}')"

  if [[ "$expect_image" -eq 1 ]]; then
    local host=""
    host="$(extract_hostname "$effective_url")"
    if [[ -n "$host" ]] && is_rejected_thumbnail_host "$host"; then
      echo "FAIL url=$url status=$status reason=thumbnail_host host=$host"
      return 1
    fi

    if [[ -z "$content_type" || "$content_type" != image/* ]]; then
      echo "FAIL url=$url status=$status content_type=${content_type:-<empty>}"
      return 1
    fi

    local content_length_raw=""
    content_length_raw="$(printf '%s\n' "$headers" | extract_last_header_value "content-length" | tr -d '[:space:]')"
    local content_length=""
    if [[ -n "$content_length_raw" && "$content_length_raw" =~ ^[0-9]+$ ]]; then
      content_length="$content_length_raw"
    fi

    if [[ "$min_bytes" -gt 0 && -n "$content_length" && "$content_length" -lt "$min_bytes" ]]; then
      echo "FAIL url=$url status=$status content_type=$content_type reason=too_small_bytes content_length=$content_length min_bytes=$min_bytes"
      return 1
    fi

    local tmp=""
    tmp="$(mktemp)"
    if ! curl -fsSL --compressed --connect-timeout "$connect_timeout" --max-time "$max_time" --max-filesize "$max_bytes" --range "0-$((max_bytes-1))" -o "$tmp" "${curl_headers[@]}" "$effective_url" 2>/dev/null; then
      if ! curl -fsSL --compressed --connect-timeout "$connect_timeout" --max-time "$max_time" --max-filesize "$max_bytes" -o "$tmp" "${curl_headers[@]}" "$effective_url" 2>/dev/null; then
        rm -f "$tmp" || true
        echo "FAIL url=$url status=$status content_type=$content_type reason=download"
        return 1
      fi
    fi

    local downloaded_bytes=""
    downloaded_bytes="$(wc -c <"$tmp" | tr -d '[:space:]')"
    if [[ "$min_bytes" -gt 0 && "$downloaded_bytes" =~ ^[0-9]+$ && "$downloaded_bytes" -lt "$min_bytes" ]]; then
      rm -f "$tmp" || true
      echo "FAIL url=$url status=$status content_type=$content_type reason=too_small_bytes downloaded_bytes=$downloaded_bytes min_bytes=$min_bytes"
      return 1
    fi

    local meta=""
    meta="$(bun "$script_dir/image_meta.mjs" "$tmp" 2>/dev/null || true)"
    rm -f "$tmp" || true

    local width=""
    local height=""
    width="$(printf '%s' "$meta" | awk -F'width=' '{print $2}' | awk '{print $1}')"
    height="$(printf '%s' "$meta" | awk -F'height=' '{print $2}' | awk '{print $1}')"
    if [[ -z "$width" || -z "$height" || ! "$width" =~ ^[0-9]+$ || ! "$height" =~ ^[0-9]+$ ]]; then
      echo "FAIL url=$url status=$status content_type=$content_type reason=no_dimensions"
      return 1
    fi

    if [[ -n "$min_width" && "$width" -lt "$min_width" ]]; then
      echo "FAIL url=$url status=$status content_type=$content_type reason=too_small width=$width height=$height min_width=$min_width"
      return 1
    fi
    if [[ -n "$min_height" && "$height" -lt "$min_height" ]]; then
      echo "FAIL url=$url status=$status content_type=$content_type reason=too_small width=$width height=$height min_height=$min_height"
      return 1
    fi
    if [[ -n "$min_short_side" && "$min_short_side" -gt 0 ]]; then
      local short_side="$width"
      if [[ "$height" -lt "$short_side" ]]; then
        short_side="$height"
      fi
      if [[ "$short_side" -lt "$min_short_side" ]]; then
        echo "FAIL url=$url status=$status content_type=$content_type reason=too_small width=$width height=$height min_short_side=$min_short_side"
        return 1
      fi
    fi
  fi

  if [[ "$expect_image" -eq 1 && -n "$width" && -n "$height" ]]; then
    echo "OK url=$url status=$status content_type=${content_type:-<empty>} width=$width height=$height"
    return 0
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
