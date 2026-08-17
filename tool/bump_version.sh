#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBSPEC="$ROOT/apps/mobile-flutter/pubspec.yaml"

if [[ ! -f "$PUBSPEC" ]]; then
  echo "pubspec.yaml not found"
  exit 1
fi

current="$(rg '^version:' "$PUBSPEC" | head -1 | sed 's/^version:[[:space:]]*//')"

validate_version() {
  local v="$1"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$ ]]
}

set_version() {
  local next="$1"
  perl -0pi -e "s/^version:\s*.*$/version: ${next}/m" "$PUBSPEC"
  echo "Updated version: $current -> $next"
}

if [[ "${1:-}" == "--set" ]]; then
  next="${2:-}"
  if [[ -z "$next" ]]; then
    echo "Usage: ./tool/bump_version.sh --set X.Y.Z+N"
    exit 1
  fi
  if ! validate_version "$next"; then
    echo "Invalid version format: $next"
    echo "Expected: X.Y.Z+N (example: 1.0.1+2)"
    exit 1
  fi
  set_version "$next"
  exit 0
fi

echo "Current version: $current"
read -r -p "New version (X.Y.Z+N): " next

while ! validate_version "$next"; do
  echo "Invalid version format. Example: 1.0.1+2"
  read -r -p "New version (X.Y.Z+N): " next
done

set_version "$next"
