#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"
cd "$MOBILE_ROOT"

DEVICE_ID="${1:-${DEVICE_ID:-}}"
PACKAGE_NAME="com.voice2text.app"
TEST_PACKAGE_NAME="com.voice2text.app.test"
if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(flutter devices --machine | python3 -c '
import json, sys
devices = [d for d in json.load(sys.stdin) if d.get("targetPlatform") == "android-arm64" or str(d.get("targetPlatform", "")).startswith("android")]
if len(devices) != 1:
    raise SystemExit("Pass one Android device id: ./tool/run_audio_flow_smoke.sh <device-id>")
print(devices[0]["id"])
')"
fi
python3 "$ROOT/tool/build_cache_guard.py"

PRESERVE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/voice2text-audio-smoke.XXXXXX")"
PRESERVE_ARCHIVE="$PRESERVE_ROOT/app-data.tar"
PRESERVE_VERIFY_ARCHIVE="$PRESERVE_ROOT/app-data-restored.tar"
PRESERVE_APK="$PRESERVE_ROOT/installed.apk"
PRESERVE_TEST_APK="$PRESERVE_ROOT/installed-test.apk"
PRESERVE_RESTORE_LOG="$PRESERVE_ROOT/restore.log"
PRESERVE_EXPECTED_ROOT="$PRESERVE_ROOT/expected"
PRESERVE_ACTUAL_ROOT="$PRESERVE_ROOT/actual"
HAD_INSTALLED_APP=false
HAD_INSTALLED_TEST_APP=false
RESTORE_FINISHED=false
HAD_RECORD_AUDIO_PERMISSION=false
HAD_NOTIFICATION_PERMISSION=false

restore_installed_app() {
  if [[ "$RESTORE_FINISHED" == "true" ]]; then
    return
  fi
  RESTORE_FINISHED=true

  if [[ "$HAD_INSTALLED_APP" == "true" ]]; then
    echo "Restoring the pre-smoke app and private data..."
    adb -s "$DEVICE_ID" install -r "$PRESERVE_APK" >/dev/null
    adb -s "$DEVICE_ID" shell pm clear "$PACKAGE_NAME" >/dev/null
    if [[ "$HAD_RECORD_AUDIO_PERMISSION" == "true" ]]; then
      adb -s "$DEVICE_ID" shell pm grant \
        "$PACKAGE_NAME" android.permission.RECORD_AUDIO
    fi
    if [[ "$HAD_NOTIFICATION_PERMISSION" == "true" ]]; then
      adb -s "$DEVICE_ID" shell pm grant \
        "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS
    fi
    adb -s "$DEVICE_ID" shell am force-stop "$PACKAGE_NAME"
    if ! adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
      tar -xf - <"$PRESERVE_ARCHIVE" 2>"$PRESERVE_RESTORE_LOG"; then
      if [[ ! -s "$PRESERVE_RESTORE_LOG" ]] ||
        grep -Ev \
          "^tar: chown [0-9]+:[0-9]+ '.*': Operation not permitted$" \
          "$PRESERVE_RESTORE_LOG" |
          grep -q .; then
        cat "$PRESERVE_RESTORE_LOG" >&2
        return 1
      fi
      echo "Ignored legacy Android tar owner warnings after content restore."
    fi

    adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
      tar --exclude=./cache --exclude=./code_cache -cf - . \
      >"$PRESERVE_VERIFY_ARCHIVE"
    mkdir -p "$PRESERVE_EXPECTED_ROOT" "$PRESERVE_ACTUAL_ROOT"
    tar -xf "$PRESERVE_ARCHIVE" -C "$PRESERVE_EXPECTED_ROOT"
    tar -xf "$PRESERVE_VERIFY_ARCHIVE" -C "$PRESERVE_ACTUAL_ROOT"
    if ! diff -qr "$PRESERVE_EXPECTED_ROOT" "$PRESERVE_ACTUAL_ROOT"; then
      echo "Restored app data does not match the pre-smoke archive." >&2
      return 1
    fi
    echo "Verified restored app data byte-for-byte."
  else
    adb -s "$DEVICE_ID" uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true
  fi

  if [[ "$HAD_INSTALLED_TEST_APP" == "true" ]]; then
    adb -s "$DEVICE_ID" install -r "$PRESERVE_TEST_APK" >/dev/null
  else
    adb -s "$DEVICE_ID" uninstall "$TEST_PACKAGE_NAME" >/dev/null 2>&1 || true
  fi

  rm -rf -- "$PRESERVE_ROOT"
}
trap restore_installed_app EXIT INT TERM

if adb -s "$DEVICE_ID" shell pm path "$PACKAGE_NAME" >/dev/null 2>&1; then
  HAD_INSTALLED_APP=true
  echo "Preserving the installed app's private data..."
  if adb -s "$DEVICE_ID" shell dumpsys package "$PACKAGE_NAME" |
    grep -q "android.permission.RECORD_AUDIO: granted=true"; then
    HAD_RECORD_AUDIO_PERMISSION=true
  fi
  if adb -s "$DEVICE_ID" shell dumpsys package "$PACKAGE_NAME" |
    grep -q "android.permission.POST_NOTIFICATIONS: granted=true"; then
    HAD_NOTIFICATION_PERMISSION=true
  fi
  adb -s "$DEVICE_ID" shell am force-stop "$PACKAGE_NAME"
  INSTALLED_APK_PATH="$(
    adb -s "$DEVICE_ID" shell pm path "$PACKAGE_NAME" |
      head -n 1 |
      tr -d '\r' |
      cut -d: -f2-
  )"
  test -n "$INSTALLED_APK_PATH"
  adb -s "$DEVICE_ID" pull "$INSTALLED_APK_PATH" "$PRESERVE_APK" >/dev/null
  test -s "$PRESERVE_APK"
  adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
    tar --exclude=./cache --exclude=./code_cache -cf - . >"$PRESERVE_ARCHIVE"
  test -s "$PRESERVE_ARCHIVE"
fi

if adb -s "$DEVICE_ID" shell pm path "$TEST_PACKAGE_NAME" >/dev/null 2>&1; then
  HAD_INSTALLED_TEST_APP=true
  INSTALLED_TEST_APK_PATH="$(
    adb -s "$DEVICE_ID" shell pm path "$TEST_PACKAGE_NAME" |
      head -n 1 |
      tr -d '\r' |
      cut -d: -f2-
  )"
  test -n "$INSTALLED_TEST_APK_PATH"
  adb -s "$DEVICE_ID" pull "$INSTALLED_TEST_APK_PATH" "$PRESERVE_TEST_APK" >/dev/null
  test -s "$PRESERVE_TEST_APK"
fi

echo "[1/4] Offline audio review flow on $DEVICE_ID"
flutter test integration_test/audio_offline_flow_test.dart \
  -d "$DEVICE_ID" \
  --plain-name \
  "timestamped audio can play, edit, search, export and review evidence"

echo "[2/4] Large audio lazy timeline flow on $DEVICE_ID"
# Run the 3000-segment case in a fresh process. Android may deliver a focus-loss
# event while a same-process test suite transitions between cases; combining
# that event with a large debug-mode frame can trigger the platform ANR watchdog
# even though each product flow is independently healthy.
flutter test integration_test/audio_offline_flow_test.dart \
  -d "$DEVICE_ID" \
  --plain-name \
  "3000 segments stay lazy and support far review search and VTT export"

echo "[3/4] Queue recovery and deletion retry flow on $DEVICE_ID"
flutter test integration_test/audio_recovery_flow_test.dart -d "$DEVICE_ID"

echo "[4/4] Real punctuation model and ranged VTT receiver flow on $DEVICE_ID"
flutter build apk --debug
(
  cd android
  ./gradlew :app:assembleDebugAndroidTest
)
adb -s "$DEVICE_ID" install -r build/app/outputs/flutter-apk/app-debug.apk >/dev/null
adb -s "$DEVICE_ID" install -r \
  build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
adb -s "$DEVICE_ID" shell am instrument -w -r \
  -e class \
  com.voice2text.app.transcription.PunctuationModelSmokeTest,com.voice2text.app.sharing.AudioRangeVttShareSmokeTest \
  "$TEST_PACKAGE_NAME/androidx.test.runner.AndroidJUnitRunner"

restore_installed_app
trap - EXIT INT TERM
echo "Audio flow smoke finished."
