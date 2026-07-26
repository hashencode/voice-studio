#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PHASE=""
CANDIDATE=""
DEVICE_ID="${DEVICE_ID:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE="${2:-}"
      shift 2
      ;;
    --candidate)
      CANDIDATE="${2:-}"
      shift 2
      ;;
    --device)
      DEVICE_ID="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$PHASE" != "screen" && "$PHASE" != "final" ]]; then
  echo "--phase must be screen or final." >&2
  exit 2
fi
if [[ "$CANDIDATE" != "sherpa-v1.13.3-pyannote-3dspeaker" &&
  "$CANDIDATE" != "sherpa-v1.13.3-pyannote-int8-3dspeaker" ]]; then
  echo "Unsupported or unfrozen candidate: $CANDIDATE" >&2
  exit 2
fi

PACKAGE_NAME="com.voice2text.app"
TEST_PACKAGE_NAME="com.voice2text.app.test"
WORK_ROOT="$ROOT/build/speaker_diarization"
MODEL_ROOT="$WORK_ROOT/models"
SOURCE_ROOT="$WORK_ROOT/sources"
FIXTURE_ROOT="$WORK_ROOT/fixtures"
OUTPUT_ROOT="$WORK_ROOT/evidence/$PHASE/$CANDIDATE"
SEGMENTATION_ARCHIVE="$MODEL_ROOT/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
if [[ "$CANDIDATE" == "sherpa-v1.13.3-pyannote-int8-3dspeaker" ]]; then
  SCREENING_CONTRACT="$ROOT/benchmark/speaker_diarization_admission_contract.json"
  SEGMENTATION_MODEL="$MODEL_ROOT/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx"
  SEGMENTATION_SHA256="d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d"
  SEGMENTATION_DEVICE_NAME="pyannote-segmentation-3-0-int8.onnx"
  FUNCTIONAL_TEST_CLASS="com.voice2text.app.speakers.SelectedFallbackSpeakerDiarizationSmokeTest#runSelectedFallbackFiveMinuteProbe"
else
  SCREENING_CONTRACT="$ROOT/benchmark/speaker_diarization_current_screening_contract.json"
  SEGMENTATION_MODEL="$MODEL_ROOT/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
  SEGMENTATION_SHA256="220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
  SEGMENTATION_DEVICE_NAME="pyannote-segmentation-3-0.onnx"
  FUNCTIONAL_TEST_CLASS="com.voice2text.app.speakers.SpeakerDiarizationFiveMinuteSmokeTest#runLicensedFiveMinuteCandidateProbe"
fi
EMBEDDING_MODEL="$MODEL_ROOT/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(
    adb devices |
      awk 'NR > 1 && $2 == "device" && $1 !~ /^emulator-/ && $1 !~ /:/ {print $1}'
  )"
  if [[ "$(printf '%s\n' "$DEVICE_ID" | awk 'NF {count += 1} END {print count + 0}')" -ne 1 ]]; then
    echo "Pass exactly one USB physical Android device with --device." >&2
    exit 2
  fi
fi

if [[ "$(adb -s "$DEVICE_ID" shell getprop ro.kernel.qemu | tr -d '\r')" == "1" ]]; then
  echo "Speaker admission evidence requires a physical Android device." >&2
  exit 2
fi

REMOTE_ROOT="/data/local/tmp/voice2text-speaker-gate-$$"
cleanup_remote() {
  adb -s "$DEVICE_ID" shell rm -r -- "$REMOTE_ROOT" >/dev/null 2>&1 || true
  adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
    rm -r files/speaker-diarization >/dev/null 2>&1 || true
  adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
    rm -f files/device-evidence/speaker-diarization-five-minute.json \
    files/device-evidence/speaker-diarization-resource.json >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT INT TERM

download() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  mkdir -p "$(dirname "$destination")"
  if [[ ! -s "$destination" ]] ||
    [[ "$(shasum -a 256 "$destination" | awk '{print $1}')" != "$expected_sha256" ]]; then
    curl -fL --retry 3 -o "$destination" "$url"
  fi
  test "$(shasum -a 256 "$destination" | awk '{print $1}')" = "$expected_sha256"
}

echo "[1/8] Download and verify licensed candidate artifacts"
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
  "$SEGMENTATION_ARCHIVE" \
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
tar -xjf "$SEGMENTATION_ARCHIVE" -C "$MODEL_ROOT"
test "$(shasum -a 256 "$SEGMENTATION_MODEL" | awk '{print $1}')" = \
  "$SEGMENTATION_SHA256"
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  "$EMBEDDING_MODEL" \
  "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"

echo "[2/8] Download and verify licensed fixture sources"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker1_a_cn_16k.wav" \
  "$SOURCE_ROOT/speaker1_a_cn_16k.wav" \
  "5f20ce0ddc378ca3239d3ce864b1142726a46a1221ae553912e4e142045df58b"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker1_b_cn_16k.wav" \
  "$SOURCE_ROOT/speaker1_b_cn_16k.wav" \
  "20745dc08a4281894d146140b99b9ef7417ac681119b7f7202f553cdf1a85f65"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker2_a_cn_16k.wav" \
  "$SOURCE_ROOT/speaker2_a_cn_16k.wav" \
  "8a6cffa452df32ef10503f7992f22ffcdd7f16c4e0273d13311bc5cdcb13abf4"

echo "[3/8] Generate deterministic 5/120-minute fixtures"
python3 benchmark/prepare_speaker_diarization_fixtures.py \
  --manifest "$SCREENING_CONTRACT"

echo "[4/8] Build app and AndroidTest APKs"
(
  cd android
  ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
)

echo "[5/8] Install and stage candidate artifacts in app-private storage"
adb -s "$DEVICE_ID" install -r -d \
  build/app/outputs/flutter-apk/app-debug.apk >/dev/null
adb -s "$DEVICE_ID" install -r -d \
  build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
adb -s "$DEVICE_ID" shell mkdir -p "$REMOTE_ROOT"
adb -s "$DEVICE_ID" push "$SEGMENTATION_MODEL" "$REMOTE_ROOT/segmentation.onnx" >/dev/null
adb -s "$DEVICE_ID" push "$EMBEDDING_MODEL" "$REMOTE_ROOT/embedding.onnx" >/dev/null
adb -s "$DEVICE_ID" push \
  "$FIXTURE_ROOT/speaker-functional-5m.wav" \
  "$REMOTE_ROOT/speaker-functional-5m.wav" >/dev/null
if [[ "$PHASE" == "final" ]]; then
  adb -s "$DEVICE_ID" push \
    "$FIXTURE_ROOT/speaker-resource-120m.wav" \
    "$REMOTE_ROOT/speaker-resource-120m.wav" >/dev/null
fi
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  mkdir -p files/speaker-diarization/models \
  files/speaker-diarization/fixtures \
  files/device-evidence
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  cp "$REMOTE_ROOT/segmentation.onnx" \
  "files/speaker-diarization/models/$SEGMENTATION_DEVICE_NAME"
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  cp "$REMOTE_ROOT/embedding.onnx" \
  files/speaker-diarization/models/3dspeaker-eres2net-base.onnx
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  cp "$REMOTE_ROOT/speaker-functional-5m.wav" \
  files/speaker-diarization/fixtures/speaker-functional-5m.wav
if [[ "$PHASE" == "final" ]]; then
  adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
    cp "$REMOTE_ROOT/speaker-resource-120m.wav" \
    files/speaker-diarization/fixtures/speaker-resource-120m.wav
fi
adb -s "$DEVICE_ID" shell run-as "$PACKAGE_NAME" \
  rm -f files/device-evidence/speaker-diarization-five-minute.json \
  files/device-evidence/speaker-diarization-resource.json

echo "[6/8] Run physical 5-minute functional probe"
adb -s "$DEVICE_ID" shell am instrument -w -r \
  -e speakerDiarizationProbe true \
  -e speakerDiarizationCandidate "$CANDIDATE" \
  -e class \
  "$FUNCTIONAL_TEST_CLASS" \
  "$TEST_PACKAGE_NAME/androidx.test.runner.AndroidJUnitRunner"

echo "[7/8] Pull and evaluate the 5-minute screen"
mkdir -p "$OUTPUT_ROOT"
adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
  cat files/device-evidence/speaker-diarization-five-minute.json \
  >"$OUTPUT_ROOT/speaker-diarization-five-minute.json"
if [[ "$PHASE" == "screen" ]]; then
  SCREENING_REPORT="$OUTPUT_ROOT/speaker-diarization-evaluation.json"
else
  SCREENING_REPORT="$OUTPUT_ROOT/speaker-diarization-screening-evaluation.json"
fi
screening_args=(
  --phase screen
  --contract "$SCREENING_CONTRACT"
  --generated "$FIXTURE_ROOT/generated_manifest.json"
  --five-minute-evidence "$OUTPUT_ROOT/speaker-diarization-five-minute.json"
  --rttm "$FIXTURE_ROOT/speaker-functional-5m.rttm"
  --report "$SCREENING_REPORT"
)
python3 benchmark/evaluate_speaker_diarization.py "${screening_args[@]}"
evidence_files=(
  "$OUTPUT_ROOT/speaker-diarization-five-minute.json"
  "$SCREENING_REPORT"
)

if [[ "$PHASE" == "screen" ]]; then
  echo "[8/8] Screening complete; 120-minute probe remains gated"
  shasum -a 256 "${evidence_files[@]}"
  echo "Speaker diarization gate evidence ready under $OUTPUT_ROOT."
  exit 0
fi

screening_decision="$(
  python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["decision"])' \
    "$SCREENING_REPORT"
)"
if [[ "$screening_decision" != "ADVANCE_TO_FINAL_GATE" ]]; then
  shasum -a 256 "${evidence_files[@]}"
  echo "Final gate blocked by 5-minute decision: $screening_decision" >&2
  exit 1
fi

echo "[8/8] Run and evaluate the bounded physical 120-minute resource probe"
adb -s "$DEVICE_ID" shell am instrument -w -r \
  -e speakerDiarizationProbe true \
  -e speakerDiarizationCandidate "$CANDIDATE" \
  -e class \
  "com.voice2text.app.speakers.SpeakerDiarizationResourceGateTest#runBoundedOneHundredTwentyMinuteResourceProbe" \
  "$TEST_PACKAGE_NAME/androidx.test.runner.AndroidJUnitRunner"
adb -s "$DEVICE_ID" exec-out run-as "$PACKAGE_NAME" \
  cat files/device-evidence/speaker-diarization-resource.json \
  >"$OUTPUT_ROOT/speaker-diarization-resource.json"
python3 benchmark/evaluate_speaker_diarization.py \
  --phase final \
  --contract "$SCREENING_CONTRACT" \
  --generated "$FIXTURE_ROOT/generated_manifest.json" \
  --five-minute-evidence "$OUTPUT_ROOT/speaker-diarization-five-minute.json" \
  --resource-evidence "$OUTPUT_ROOT/speaker-diarization-resource.json" \
  --rttm "$FIXTURE_ROOT/speaker-functional-5m.rttm" \
  --report "$OUTPUT_ROOT/speaker-diarization-evaluation.json"
evidence_files+=(
  "$OUTPUT_ROOT/speaker-diarization-resource.json"
)
evidence_files+=("$OUTPUT_ROOT/speaker-diarization-evaluation.json")
shasum -a 256 "${evidence_files[@]}"
echo "Speaker diarization gate evidence ready under $OUTPUT_ROOT."
