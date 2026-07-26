#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ASR_MODEL_ROOT="$ROOT/build/desktop_benchmark/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
SPEAKER_CACHE="$ROOT/build/speaker_diarization"
RUNTIME_ROOT="$ROOT/apps/desktop/build/macos/Build/Products/Debug/voice2text_desktop.app/Contents/Frameworks"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT/benchmark/desktop/evidence/macos-sherpa-1.13.4}"
CONTRACT_ID="desktop-processing/macos-sherpa-1.13.4-v1"
PROBES="${1:-asr,functional,resource}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-3600}"

test -f "$ASR_MODEL_ROOT/encoder-epoch-99-avg-1.int8.onnx"
test -f "$ASR_MODEL_ROOT/decoder-epoch-99-avg-1.int8.onnx"
test -f "$ASR_MODEL_ROOT/joiner-epoch-99-avg-1.int8.onnx"
test -f "$ASR_MODEL_ROOT/tokens.txt"
test -f "$SPEAKER_CACHE/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
test -f "$SPEAKER_CACHE/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
test -f "$SPEAKER_CACHE/fixtures/speaker-functional-5m.wav"
test -f "$SPEAKER_CACHE/fixtures/speaker-resource-120m.wav"
test -f "$RUNTIME_ROOT/libsherpa-onnx-c-api.dylib"

if [[ "$PROBES" == "asr,functional,resource" ]]; then
  rm -rf "$OUTPUT_ROOT"
fi
mkdir -p "$OUTPUT_ROOT"
dart run apps/desktop/tool/desktop_sherpa_benchmark.dart \
  --contract-id "$CONTRACT_ID" \
  --output-root "$OUTPUT_ROOT" \
  --runtime-root "$RUNTIME_ROOT" \
  --asr-encoder "$ASR_MODEL_ROOT/encoder-epoch-99-avg-1.int8.onnx" \
  --asr-decoder "$ASR_MODEL_ROOT/decoder-epoch-99-avg-1.int8.onnx" \
  --asr-joiner "$ASR_MODEL_ROOT/joiner-epoch-99-avg-1.int8.onnx" \
  --asr-tokens "$ASR_MODEL_ROOT/tokens.txt" \
  --asr-wav "$ROOT/benchmark/audio/zh.wav" \
  --asr-reference "$ROOT/benchmark/audio/zh.txt" \
  --segmentation-model \
  "$SPEAKER_CACHE/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" \
  --embedding-model \
  "$SPEAKER_CACHE/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  --speaker-functional "$SPEAKER_CACHE/fixtures/speaker-functional-5m.wav" \
  --speaker-resource "$SPEAKER_CACHE/fixtures/speaker-resource-120m.wav" \
  --timeout-seconds "$TIMEOUT_SECONDS" \
  --num-threads 2 \
  --probes "$PROBES"

if [[ "$PROBES" == "asr,functional,resource" ]]; then
  python3 benchmark/desktop/validate_desktop_evidence.py \
    --contract benchmark/desktop/desktop_benchmark_contract.json \
    --evidence-root "$OUTPUT_ROOT"
fi
