#!/usr/bin/env bash
set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${1:?destination directory is required}"
DART_BIN="${DART_BIN:-dart}"
mkdir -p "$DESTINATION"

cd "$DESKTOP_ROOT"
"$DART_BIN" compile exe \
  "$DESKTOP_ROOT/tool/desktop_sherpa_worker.dart" \
  -o "$DESTINATION/desktop_sherpa_worker"
# `dart compile exe` embeds a random six-character compiler workspace in the
# Mach-O string table. Normalize that non-semantic path before signing so the
# packaged worker has a reproducible SHA-256 for target evidence.
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$DESTINATION/desktop_sherpa_worker"
codesign --force --sign - "$DESTINATION/desktop_sherpa_worker"
clang -O2 \
  "$DESKTOP_ROOT/tool/native_process_group_launcher.c" \
  -o "$DESTINATION/native_process_group_launcher"
chmod 755 \
  "$DESTINATION/desktop_sherpa_worker" \
  "$DESTINATION/native_process_group_launcher"

if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" ]] &&
  [[ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$DESTINATION/desktop_sherpa_worker"
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$DESTINATION/native_process_group_launcher"
fi
