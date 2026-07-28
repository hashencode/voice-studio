#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

test -f apps/desktop/macos/Runner/SecureLocalImportPlugin.swift
test -f apps/desktop/macos/Runner/Capture/RecordingMenuBarController.swift
test ! -d apps/desktop/windows
test -f docs/architecture/desktop-runtime-boundaries.md

grep -A4 -q \
  'applicationShouldTerminateAfterLastWindowClosed.*' \
  apps/desktop/macos/Runner/AppDelegate.swift
if ! grep -A4 \
  'applicationShouldTerminateAfterLastWindowClosed.*' \
  apps/desktop/macos/Runner/AppDelegate.swift | grep -q 'return false'; then
  echo "Closing the main window must not terminate an active desktop capture." >&2
  exit 1
fi

grep -q '^resolution: workspace$' apps/desktop/pubspec.yaml
for dependency in \
  companion_protocol \
  file_selector \
  flutter_secure_storage \
  media_kit \
  meeting_storage \
  sqflite_common_ffi
do
  grep -q "^  ${dependency}:" apps/desktop/pubspec.yaml
done

# The workstation shell must remain launchable below the local-processing
# runtime floor. Sherpa/ONNX belongs only to the isolated worker package.
if grep -q '^  sherpa_onnx:' apps/desktop/pubspec.yaml; then
  echo "Desktop shell must not link sherpa_onnx directly." >&2
  exit 1
fi
grep -q '^  sherpa_onnx:' packages/desktop_sherpa_worker/pubspec.yaml
grep -q '^  - packages/desktop_sherpa_worker$' pubspec.yaml

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
