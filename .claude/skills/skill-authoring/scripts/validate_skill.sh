#!/usr/bin/env bash
set -euo pipefail

skill_dir="${1:-}"

if [[ -z "$skill_dir" ]]; then
  echo "Usage: scripts/validate_skill.sh <skill-dir>" >&2
  exit 1
fi

skill_file="$skill_dir/SKILL.md"
if [[ ! -f "$skill_file" ]]; then
  echo "Missing SKILL.md: $skill_file" >&2
  exit 2
fi

first_line="$(head -n 1 "$skill_file")"
if [[ "$first_line" != "---" ]]; then
  echo "Frontmatter must start with --- on line 1." >&2
  exit 3
fi

frontmatter="$(awk 'NR==1{next} $0=="---"{exit} {print}' "$skill_file")"
if [[ -z "$frontmatter" ]]; then
  echo "Frontmatter is empty or missing closing ---." >&2
  exit 4
fi

name_line="$(printf "%s\n" "$frontmatter" | grep -E -m 1 '^name:[[:space:]]*.+$' || true)"
desc_line="$(printf "%s\n" "$frontmatter" | grep -E -m 1 '^description:[[:space:]]*.+$' || true)"

if [[ -z "$name_line" ]]; then
  echo "Frontmatter missing name: field." >&2
  exit 5
fi

if [[ -z "$desc_line" ]]; then
  echo "Frontmatter missing description: field." >&2
  exit 6
fi

skill_name="${name_line#name:}"
skill_name="$(echo "$skill_name" | tr -d ' ' )"

if ! [[ "$skill_name" =~ ^[a-z0-9-]+$ ]]; then
  echo "Skill name must be lowercase letters, digits, or hyphens: $skill_name" >&2
  exit 7
fi

extra_keys="$(printf "%s\n" "$frontmatter" | grep -E '^[a-zA-Z0-9_-]+:' | grep -E -v '^(name|description):' || true)"
if [[ -n "$extra_keys" ]]; then
  echo "Frontmatter has unsupported keys:" >&2
  printf "%s\n" "$extra_keys" >&2
  exit 8
fi

echo "OK: $skill_file"
