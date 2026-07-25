#!/usr/bin/env bash

set -euo pipefail

DEVICE_ID="${1:-emulator-5554}"
APP_ID="${2:-com.voice2text.app}"
CAPTURE_SECONDS="${3:-60}"
APK_PATH="build/app/outputs/flutter-apk/app-debug.apk"
LOG_DIR="build/smoke"
LOG_FILE="$LOG_DIR/logcat-$(date +%Y%m%d-%H%M%S).txt"

mkdir -p "$LOG_DIR"

echo "[1/5] Checking device: $DEVICE_ID"
adb -s "$DEVICE_ID" get-state >/dev/null

echo "[2/5] Building debug APK"
flutter build apk --debug >/dev/null

echo "[3/5] Installing APK"
adb -s "$DEVICE_ID" install -r "$APK_PATH" >/dev/null

echo "[4/5] Launching app: $APP_ID"
adb -s "$DEVICE_ID" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null

echo "[5/5] Capturing logs (${CAPTURE_SECONDS}s) -> $LOG_FILE"
echo "Now operate app on device: record -> stop/save (within ${CAPTURE_SECONDS}s)"
adb -s "$DEVICE_ID" logcat -c

capture_cmd=(
  adb -s "$DEVICE_ID" logcat -v time
  Voice2TextNative:I
  flutter:I
  AndroidRuntime:E
  '*:S'
)

if command -v timeout >/dev/null 2>&1; then
  timeout "$CAPTURE_SECONDS" "${capture_cmd[@]}" | tee "$LOG_FILE" || true
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout "$CAPTURE_SECONDS" "${capture_cmd[@]}" | tee "$LOG_FILE" || true
else
  # Fallback for environments without timeout/gtimeout.
  "${capture_cmd[@]}" >"$LOG_FILE" 2>&1 &
  logcat_pid=$!
  sleep "$CAPTURE_SECONDS"
  kill "$logcat_pid" >/dev/null 2>&1 || true
  wait "$logcat_pid" 2>/dev/null || true
  cat "$LOG_FILE"
fi

echo "Smoke run finished."
echo "Next: run ./tool/check_transcribe_log.sh $LOG_FILE"
