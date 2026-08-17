#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"
TEMPLATE="$MOBILE_ROOT/android/key.properties.example"
TARGET="$MOBILE_ROOT/android/key.properties"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Template not found: $TEMPLATE"
  exit 1
fi

if [[ -f "$TARGET" ]]; then
  echo "Already exists: $TARGET"
  echo "Skip. Edit the file directly if you need updates."
  exit 0
fi

cp "$TEMPLATE" "$TARGET"

echo "Created: $TARGET"
echo "Next: edit applicationId/storeFile/storePassword/keyAlias/keyPassword"
