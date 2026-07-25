#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "RUNTIME CONTRACT FAILED: $1" >&2
  exit 1
}

[[ -f android/app/src/main/kotlin/com/voice2text/app/transcription/RealSherpaTranscriptionEngine.kt ]] ||
  fail "real transcription engine is not in the main source set"
[[ -f android/app/libs/sherpa-onnx.aar ]] ||
  fail "Sherpa AAR is missing"

for asset in \
  assets/sherpa/asr/paraformer-zh.zip \
  assets/sherpa/asr/paraformer-zh.json \
  assets/sherpa/onnx/silero-vad.onnx; do
  [[ -f "$asset" ]] || fail "required model asset is missing: $asset"
done

if rg -n \
  'default-flavor|productFlavors|flavorDimensions|fullImplementation|src/(ui|full)|StubSherpa|TranscriptionEngineMode|engineMode|--flavor|app-full-debug|FLAVOR=' \
  pubspec.yaml android/app lib tool README.md \
  --glob '!check_runtime_contract.sh' >/dev/null; then
  fail "a flavor, stub, or runtime-selection product path remains"
fi

if rg -n 'live_vad|sherpa-streaming-zh' lib android/app/src/main >/dev/null; then
  fail "a mobile Live VAD or streaming-model product path remains"
fi

echo "Runtime contract check passed: one flavor-free real offline runtime."
