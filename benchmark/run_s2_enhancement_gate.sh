#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"

DEVICE_ID="${1:-${DEVICE_ID:-}}"
PACKAGE_NAME="com.voice2text.app"
TEST_PACKAGE_NAME="com.voice2text.app.test"
MODEL_ID="paraformer-zh-2025-10-07"
MODEL_ROOT="$ROOT/build/asr_benchmark/models/sherpa-onnx-paraformer-zh-int8-2025-10-07"
NOISE_ROOT="$ROOT/build/asr_benchmark/s2_noise"
OUTPUT_ROOT="$ROOT/build/asr_benchmark"

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(
    adb devices |
      awk 'NR > 1 && $2 == "device" && $1 !~ /^emulator-/ {print $1}'
  )"
  if [[ "$(printf '%s\n' "$DEVICE_ID" | awk 'NF {count += 1} END {print count + 0}')" -ne 1 ]]; then
    echo "Pass exactly one physical Android device id." >&2
    exit 2
  fi
fi

if [[ "$(adb -s "$DEVICE_ID" shell getprop ro.kernel.qemu | tr -d '\r')" == "1" ]]; then
  echo "S2 enhancement evidence requires a physical Android device." >&2
  exit 2
fi

REMOTE_ROOT="/data/local/tmp/voice2text-s2-enhancement-$$"
cleanup_remote() {
  adb -s "$DEVICE_ID" shell rm -r -- "$REMOTE_ROOT" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT INT TERM

echo "[1/7] Verify and prepare pinned production model"
python3 benchmark/validate_asr_model_candidates.py
./benchmark/download_asr_benchmark_models.sh "$MODEL_ID"
test -s "$MODEL_ROOT/model.int8.onnx"
test -s "$MODEL_ROOT/tokens.txt"

echo "[2/7] Generate deterministic five-case audio set"
python3 benchmark/prepare_s2_noise_audio.py
test -s "$NOISE_ROOT/generated_manifest.json"

echo "[3/7] Build app and AndroidTest APKs"
python3 "$ROOT/tool/build_cache_guard.py"
(
  cd "$MOBILE_ROOT/android"
  ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
)

echo "[4/7] Install without clearing app-private data"
adb -s "$DEVICE_ID" install -r -d \
  "$MOBILE_ROOT/build/app/outputs/flutter-apk/app-debug.apk" >/dev/null
adb -s "$DEVICE_ID" install -r -d \
  "$MOBILE_ROOT/build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk" >/dev/null

echo "[5/7] Stage pinned model and fixtures"
adb -s "$DEVICE_ID" shell mkdir -p "$REMOTE_ROOT"
adb -s "$DEVICE_ID" push "$MODEL_ROOT/model.int8.onnx" "$REMOTE_ROOT/model.int8.onnx" >/dev/null
adb -s "$DEVICE_ID" push "$MODEL_ROOT/tokens.txt" "$REMOTE_ROOT/tokens.txt" >/dev/null
for case_id in quiet_clean steady_noise_5db burst_noise_0db near_talk far_talk_5db; do
  adb -s "$DEVICE_ID" push "$NOISE_ROOT/$case_id.wav" "$REMOTE_ROOT/$case_id.wav" >/dev/null
done
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  mkdir -p cache/sherpa_models/paraformer_zh files/s2-noise
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  cp "$REMOTE_ROOT/model.int8.onnx" cache/sherpa_models/paraformer_zh/model.int8.onnx
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  cp "$REMOTE_ROOT/tokens.txt" cache/sherpa_models/paraformer_zh/tokens.txt
for case_id in quiet_clean steady_noise_5db burst_noise_0db near_talk far_talk_5db; do
  adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
    cp "$REMOTE_ROOT/$case_id.wav" "files/s2-noise/$case_id.wav"
done

echo "[6/7] Run complete raw/enhanced physical-device gate"
adb -s "$DEVICE_ID" shell am instrument -w -r \
  -e class \
  com.voice2text.app.transcription.SpeechEnhancementPairedGateTest \
  "$TEST_PACKAGE_NAME/androidx.test.runner.AndroidJUnitRunner"
adb -s "$DEVICE_ID" shell am instrument -w -r \
  -e class \
  com.voice2text.app.transcription.SpeechEnhancementEvidenceIdentityTest \
  "$TEST_PACKAGE_NAME/androidx.test.runner.AndroidJUnitRunner"

echo "[7/7] Pull and evaluate evidence"
mkdir -p "$OUTPUT_ROOT"
adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
  cat files/device-evidence/speech-enhancement-paired-gate.json \
  >"$OUTPUT_ROOT/speech-enhancement-paired-gate.json"
adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
  cat files/device-evidence/speech-enhancement-evidence-identity.json \
  >"$OUTPUT_ROOT/speech-enhancement-evidence-identity.json"
python3 benchmark/evaluate_s2_enhancement.py \
  --evidence "$OUTPUT_ROOT/speech-enhancement-paired-gate.json" \
  --identity-evidence "$OUTPUT_ROOT/speech-enhancement-evidence-identity.json" \
  --report "$OUTPUT_ROOT/speech-enhancement-paired-evaluation.json" \
  >/dev/null
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["complete"])' \
  "$OUTPUT_ROOT/speech-enhancement-paired-gate.json")" == "True"
shasum -a 256 \
  "$OUTPUT_ROOT/speech-enhancement-paired-gate.json" \
  "$OUTPUT_ROOT/speech-enhancement-evidence-identity.json" \
  "$OUTPUT_ROOT/speech-enhancement-paired-evaluation.json"
echo "S2 enhancement gate evidence ready under $OUTPUT_ROOT."
