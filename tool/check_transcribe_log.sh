#!/usr/bin/env bash

set -euo pipefail

LOG_FILE="${1:-}"
if [[ -z "$LOG_FILE" ]]; then
  LOG_FILE="$(ls -1t build/smoke/logcat-*.txt 2>/dev/null | head -n1 || true)"
fi

if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
  echo "No log file found. Pass a file path or run ./tool/run_android_smoke.sh first."
  exit 1
fi

echo "Checking log: $LOG_FILE"

if rg -n \
  "resultText=|mergedText=|transcript(Text)?=|audioTitle=|Authorization:|Bearer [A-Za-z0-9._-]+|/data/(user|data)/[^ ]+/files/audios/" \
  "$LOG_FILE" >/dev/null 2>&1; then
  echo "Result: FAIL (found transcript, credential, title, or sensitive full-path data)"
  rg -n \
    "resultText=|mergedText=|transcript(Text)?=|audioTitle=|Authorization:|Bearer [A-Za-z0-9._-]+|/data/(user|data)/[^ ]+/files/audios/" \
    "$LOG_FILE" | head -n 20
  exit 3
fi

if rg -n "transcribe ok" "$LOG_FILE" >/dev/null 2>&1; then
  echo "Result: PASS (found successful transcription log)"
  rg -n "transcribe ok" "$LOG_FILE"
  exit 0
fi

echo "Result: FAIL (no successful transcription log found)"
echo
echo "Recent related lines:"
rg -n "Voice2TextNative|TRANSCRIBE_FAILED|转码失败|识别失败|模型资源缺失|AndroidRuntime" "$LOG_FILE" | tail -n 40 || true
exit 2
