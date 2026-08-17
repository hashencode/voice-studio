#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="/Users/studio/Documents/GitHub/voice2text/assets/sherpa"
DST_ROOT="$ROOT/apps/mobile-flutter/assets/sherpa"

mkdir -p "$DST_ROOT/asr" "$DST_ROOT/onnx" "$DST_ROOT/wav"

cp "$SRC_ROOT/asr/paraformer-zh.json" "$DST_ROOT/asr/"
cp "$SRC_ROOT/asr/paraformer-zh.zip" "$DST_ROOT/asr/"
cp "$SRC_ROOT/onnx/punctuation.onnx" "$DST_ROOT/onnx/"
cp "$SRC_ROOT/onnx/speech-enhancement.onnx" "$DST_ROOT/onnx/"
cp "$SRC_ROOT/onnx/silero-vad.onnx" "$DST_ROOT/onnx/"
cp "$SRC_ROOT/onnx/ten-vad.onnx" "$DST_ROOT/onnx/"
cp "$SRC_ROOT/wav/test.wav" "$DST_ROOT/wav/"

echo "Synced Sherpa assets to $DST_ROOT"
