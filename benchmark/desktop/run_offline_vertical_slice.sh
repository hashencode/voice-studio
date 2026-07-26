#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODEL="$ROOT/build/desktop_benchmark/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
SPEAKER="$ROOT/build/speaker_diarization"
RUNTIME="$ROOT/apps/desktop/build/macos/Build/Products/Debug/voice2text_desktop.app/Contents/Frameworks"
OUTPUT="$ROOT/benchmark/desktop/evidence/macos-sherpa-1.13.4"

dart run apps/desktop/tool/offline_vertical_slice.dart \
  --source "$ROOT/benchmark/audio/zh.wav" \
  --duration-seconds 300.6549375 \
  --output-root "$OUTPUT" \
  --runtime-root "$RUNTIME" \
  --encoder "$MODEL/encoder-epoch-99-avg-1.int8.onnx" \
  --decoder "$MODEL/decoder-epoch-99-avg-1.int8.onnx" \
  --joiner "$MODEL/joiner-epoch-99-avg-1.int8.onnx" \
  --tokens "$MODEL/tokens.txt" \
  --segmentation \
  "$SPEAKER/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" \
  --embedding \
  "$SPEAKER/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
