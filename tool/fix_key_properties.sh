#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"
TARGET="$MOBILE_ROOT/android/key.properties"
TEMPLATE="$MOBILE_ROOT/android/key.properties.example"

if [[ ! -f "$TARGET" ]]; then
  if [[ -f "$TEMPLATE" ]]; then
    cp "$TEMPLATE" "$TARGET"
    echo "Created $TARGET from template."
  else
    cat > "$TARGET" <<'TPL'
applicationId=com.yourcompany.voice2text
storeFile=/absolute/path/to/your-upload-keystore.jks
storePassword=REPLACE_ME
keyAlias=upload
keyPassword=REPLACE_ME
TPL
    echo "Created $TARGET with default template values."
  fi
fi

backup="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
cp "$TARGET" "$backup"
echo "Backup created: $backup"

get_current() {
  local key="$1"
  local val
  val="$(rg "^${key}=" "$TARGET" | head -1 | cut -d '=' -f2- || true)"
  echo "$val"
}

set_kv() {
  local key="$1"
  local val="$2"
  if rg -q "^${key}=" "$TARGET"; then
    perl -0pi -e "s#^${key}=.*#${key}=${val}#m" "$TARGET"
  else
    printf '%s=%s\n' "$key" "$val" >> "$TARGET"
  fi
}

validate_app_id() {
  local app_id="$1"
  [[ "$app_id" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]]
}

prompt() {
  local label="$1"
  local key="$2"
  local secret="${3:-false}"
  local current
  current="$(get_current "$key")"

  if [[ "$secret" == "true" ]]; then
    read -r -s -p "$label [current hidden, ENTER keep]: " input
    echo
  else
    read -r -p "$label [${current:-empty}]: " input
  fi

  if [[ -z "${input}" ]]; then
    echo "$current"
  else
    echo "$input"
  fi
}

if [[ "${1:-}" == "--non-interactive-example" ]]; then
  set_kv "applicationId" "com.example.voice2text"
  set_kv "storeFile" "/tmp/upload-keystore.jks"
  set_kv "storePassword" "REPLACE_ME"
  set_kv "keyAlias" "upload"
  set_kv "keyPassword" "REPLACE_ME"
  echo "Wrote non-interactive example values to $TARGET"
  exit 0
fi

echo "Configure apps/mobile-flutter/android/key.properties"
app_id="$(prompt "applicationId (e.g. com.company.voice2text)" "applicationId")"
while ! validate_app_id "$app_id"; do
  echo "Invalid applicationId format. Example: com.company.voice2text"
  app_id="$(prompt "applicationId" "applicationId")"
done

store_file="$(prompt "storeFile absolute path (.jks/.keystore)" "storeFile")"
while [[ ! "$store_file" = /* ]]; do
  echo "storeFile must be absolute path."
  store_file="$(prompt "storeFile absolute path" "storeFile")"
done

key_alias="$(prompt "keyAlias" "keyAlias")"
while [[ -z "$key_alias" ]]; do
  echo "keyAlias cannot be empty."
  key_alias="$(prompt "keyAlias" "keyAlias")"
done

store_password="$(prompt "storePassword" "storePassword" true)"
while [[ -z "$store_password" ]]; do
  echo "storePassword cannot be empty."
  store_password="$(prompt "storePassword" "storePassword" true)"
done

key_password="$(prompt "keyPassword" "keyPassword" true)"
while [[ -z "$key_password" ]]; do
  echo "keyPassword cannot be empty."
  key_password="$(prompt "keyPassword" "keyPassword" true)"
done

set_kv "applicationId" "$app_id"
set_kv "storeFile" "$store_file"
set_kv "storePassword" "$store_password"
set_kv "keyAlias" "$key_alias"
set_kv "keyPassword" "$key_password"

echo "Updated $TARGET"
echo "Next: run ./tool/preflight_release.sh"
