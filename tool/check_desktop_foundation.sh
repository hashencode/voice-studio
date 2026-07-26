#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

test -f apps/desktop/macos/Runner/SecureLocalImportPlugin.swift
test ! -d apps/desktop/windows
test -f docs/architecture/desktop-runtime-boundaries.md

grep -q '^resolution: workspace$' apps/desktop/pubspec.yaml
for dependency in \
  companion_protocol \
  file_selector \
  flutter_secure_storage \
  media_kit \
  meeting_storage \
  sherpa_onnx \
  sqflite_common_ffi
do
  grep -q "^  ${dependency}:" apps/desktop/pubspec.yaml
done

IMPORT_HOST=apps/desktop/macos/Runner/SecureLocalImportPlugin.swift
for primitive in \
  O_NOFOLLOW \
  fstat \
  st_nlink \
  st_blocks \
  volumeAvailableCapacityForImportantUsage \
  SHA256 \
  fsync \
  rename \
  resolvingSymlinksInPath
do
  grep -q "$primitive" "$IMPORT_HOST"
done

if rg -n 'class Fake|Fake[A-Za-z]*Engine|fake_[a-z_]*engine' apps/desktop/lib >/dev/null; then
  echo "Production desktop code must not install fake processing behavior." >&2
  exit 1
fi

echo "Desktop foundation contract passed."
