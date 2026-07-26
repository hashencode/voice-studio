#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DeepSeek smoke skipped: set a rotated DEEPSEEK_API_KEY." >&2
  exit 2
fi

flutter test tool/deepseek_meeting_smoke_test.dart \
  --plain-name "rotated-key fictional one-request smoke"
