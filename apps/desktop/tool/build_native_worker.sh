#!/usr/bin/env bash
set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOSITORY_ROOT="$(cd "$DESKTOP_ROOT/../.." && pwd)"
DESTINATION="${1:?destination directory is required}"
RUNTIME_DESTINATION="${2:?runtime destination directory is required}"
DART_BIN="${DART_BIN:-dart}"
mkdir -p "$DESTINATION" "$RUNTIME_DESTINATION"

cd "$REPOSITORY_ROOT"
"$DART_BIN" compile exe \
  "$REPOSITORY_ROOT/packages/desktop_sherpa_worker/bin/desktop_sherpa_worker.dart" \
  -o "$DESTINATION/desktop_sherpa_worker"
# `dart compile exe` embeds a random six-character compiler workspace in the
# Mach-O string table. Normalize that non-semantic path before signing so the
# packaged worker has a reproducible SHA-256 for target evidence.
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$DESTINATION/desktop_sherpa_worker"
codesign --force --sign - "$DESTINATION/desktop_sherpa_worker"
"$DART_BIN" compile exe \
  "$DESKTOP_ROOT/tool/desktop_sensevoice_caption_worker.dart" \
  -o "$DESTINATION/desktop_sensevoice_caption_worker"
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$DESTINATION/desktop_sensevoice_caption_worker"
codesign --force --sign - "$DESTINATION/desktop_sensevoice_caption_worker"
clang -O2 \
  "$DESKTOP_ROOT/tool/native_process_group_launcher.c" \
  -o "$DESTINATION/native_process_group_launcher"

SHERPA_MACOS_ROOT="$(
  "$DART_BIN" pub cache list |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"]["sherpa_onnx_macos"]["1.13.4"]["location"])'
)"
for runtime_name in \
  libonnxruntime.1.27.0.dylib \
  libsherpa-onnx-c-api.dylib \
  libsherpa-onnx-cxx-api.dylib; do
  install -m 755 \
    "$SHERPA_MACOS_ROOT/macos/$runtime_name" \
    "$RUNTIME_DESTINATION/$runtime_name"
  codesign --force --sign - "$RUNTIME_DESTINATION/$runtime_name"
done
chmod 755 \
  "$DESTINATION/desktop_sherpa_worker" \
  "$DESTINATION/desktop_sensevoice_caption_worker" \
  "$DESTINATION/native_process_group_launcher"

if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" ]] &&
  [[ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$DESTINATION/desktop_sherpa_worker"
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$DESTINATION/desktop_sensevoice_caption_worker"
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$DESTINATION/native_process_group_launcher"
  for runtime_name in \
    libonnxruntime.1.27.0.dylib \
    libsherpa-onnx-c-api.dylib \
    libsherpa-onnx-cxx-api.dylib; do
    codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
      "$RUNTIME_DESTINATION/$runtime_name"
  done
fi
