#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/apps/mobile-flutter/android/key.properties"

if [[ ! -f "$TARGET" ]]; then
  echo "Missing $TARGET"
  echo "Run: ./tool/init_key_properties.sh"
  exit 1
fi

backup="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
cp "$TARGET" "$backup"
echo "Backup created: $backup"

set_kv() {
  local key="$1"
  local val="$2"
  if rg -q "^${key}=" "$TARGET"; then
    perl -0pi -e "s#^${key}=.*#${key}=${val}#m" "$TARGET"
  else
    printf '%s=%s\n' "$key" "$val" >> "$TARGET"
  fi
}

if [[ "${1:-}" == "--demo" ]]; then
  set_kv "storePassword" "demo-store-password"
  set_kv "keyPassword" "demo-key-password"
  echo "Demo passwords written to $TARGET"
  exit 0
fi

read -r -s -p "storePassword: " store_password
echo
while [[ -z "$store_password" ]]; do
  echo "storePassword cannot be empty"
  read -r -s -p "storePassword: " store_password
  echo
done

read -r -s -p "keyPassword (ENTER to use same as storePassword): " key_password
echo
if [[ -z "$key_password" ]]; then
  key_password="$store_password"
fi

set_kv "storePassword" "$store_password"
set_kv "keyPassword" "$key_password"

echo "Updated storePassword/keyPassword in $TARGET"
echo "Next: ./tool/preflight_release.sh"
