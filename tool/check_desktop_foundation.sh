#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

test ! -e apps/desktop
test ! -L apps/desktop
test -f apps/desktop-electron/package.json
test -f apps/desktop-electron/src/main/index.ts
test -f packages/desktop_macos_native/Sources/SecureImport/SecureImporter.swift
test -f packages/desktop_macos_native/Sources/CaptureCore/CaptureController.swift
test -f docs/architecture/desktop-runtime-boundaries.md

# The workstation shell must remain launchable below the local-processing
# runtime floor. Sherpa/ONNX belongs only to the isolated worker package.
grep -q '^  sherpa_onnx:' packages/desktop_sherpa_worker/pubspec.yaml
grep -q '^  - packages/desktop_sherpa_worker$' pubspec.yaml

IMPORT_HOST=packages/desktop_macos_native/Sources/SecureImport/SecureImporter.swift
for primitive in \
  O_NOFOLLOW \
  fstat \
  st_nlink \
  st_blocks \
  volumeAvailableCapacityForImportantUsage \
  SHA256 \
  fsync \
  openat \
  unlinkat \
  renameatx_np
do
  grep -q "$primitive" "$IMPORT_HOST"
done

if rg -n 'apps/desktop/' \
  apps/desktop-electron/scripts \
  tool/dev_check.sh \
  tool/check_desktop_benchmark.sh |
  rg -v 'apps/desktop-electron/tests/fixtures/flutter-reference/source/apps/desktop/' \
    >/dev/null; then
  echo "Active desktop tooling must not depend on retired Flutter Desktop." >&2
  exit 1
fi

echo "Electron Desktop foundation contract passed."
