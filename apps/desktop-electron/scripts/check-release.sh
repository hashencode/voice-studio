#!/usr/bin/env bash
set -euo pipefail

electron_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"

if [[ "${VOICE2TEXT_RELEASE_VALIDATION:-}" != "1" ]]; then
  echo "release validation is disabled by default; set VOICE2TEXT_RELEASE_VALIDATION=1 only for explicit release evidence" >&2
  exit 64
fi

python3 "$repository_root/tool/audio_sidebar_release_candidate.py" prepare
