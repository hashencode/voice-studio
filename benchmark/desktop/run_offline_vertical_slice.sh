#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODEL="$ROOT/build/desktop_asr_comparison/m4/qwen3/extracted/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
SPEAKER="$ROOT/build/speaker_diarization"
RUNTIME="$ROOT/apps/desktop/build/macos/Build/Products/Debug/voice2text_desktop.app/Contents/Frameworks"
OUTPUT="$ROOT/benchmark/desktop/evidence/macos-sherpa-1.13.4"

dart run apps/desktop/tool/offline_vertical_slice.dart \
  --source "$ROOT/benchmark/audio/zh.wav" \
  --duration-seconds 300.6549375 \
  --output-root "$OUTPUT" \
  --runtime-root "$RUNTIME" \
  --conv-frontend "$MODEL/conv_frontend.onnx" \
  --encoder "$MODEL/encoder.int8.onnx" \
  --decoder "$MODEL/decoder.int8.onnx" \
  --tokenizer "$MODEL/tokenizer" \
  --vad "$MODEL/silero_vad.onnx" \
  --segmentation \
  "$SPEAKER/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" \
  --embedding \
  "$SPEAKER/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
