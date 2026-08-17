#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"
cd "$MOBILE_ROOT"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DeepSeek smoke skipped: set a rotated DEEPSEEK_API_KEY." >&2
  exit 2
fi

python3 "$ROOT/tool/build_cache_guard.py"
flutter test tool/deepseek_meeting_smoke_test.dart \
  --plain-name "rotated-key fictional one-request smoke"
