#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

test -f benchmark/desktop/desktop_benchmark_contract.json
test -f benchmark/desktop/desktop_model_candidates.json
test -f benchmark/desktop/validate_desktop_evidence.py
test -f benchmark/desktop/environments/funasr/uv.lock
test -f benchmark/desktop/environments/pyannote/uv.lock
test -f benchmark/desktop/evidence/macos/funasr-paraformer.json
test -f benchmark/desktop/evidence/macos/pyannote-community-1.json
test -f benchmark/desktop/MACOS_ENGINE_SELECTION.md
test -f apps/desktop/lib/features/processing/sherpa_desktop_processing_engine.dart
test -f apps/desktop/lib/features/processing/sidecar/sidecar_process_client.dart
test -f packages/processing_contracts/lib/src/sidecar_protocol.dart
test -f apps/desktop/macos/Runner/Processing/README.md
test -x benchmark/desktop/run_macos_sherpa_baseline.sh
test -x benchmark/desktop/prepare_macos_benchmark_assets.sh
test -x benchmark/desktop/run_offline_vertical_slice.sh
test -x benchmark/desktop/run_cancellation_probe.py
test -x benchmark/desktop/run_funasr_benchmark.py
test -x apps/desktop/tool/processing_sidecar/launcher.py
test -x apps/desktop/tool/processing_sidecar/worker.py

python3 - <<'PY'
import json
from pathlib import Path

contract = json.loads(
    Path("benchmark/desktop/desktop_benchmark_contract.json").read_text()
)
assert contract["decisionPlatform"] == "macos"
assert contract["runtime"]["version"] == "1.13.4"
assert contract["operationalEnvelope"] == {
    "maxSourceBytes": 4294967296,
    "maxDurationSeconds": 14400,
    "maxDecodedPcmBytes": 2147483648,
    "maxSegments": 200000,
    "maxQueuedJobs": 20,
    "maxConcurrentEngines": 1,
    "temporaryStorageMultiplier": 2.25,
    "minimumFreeBytesAfterImport": 2147483648,
}
assert "windows" not in contract
PY

python3 -m unittest discover -s benchmark/desktop -p 'test_*.py'
python3 benchmark/desktop/validate_desktop_candidates.py \
  --contract benchmark/desktop/desktop_benchmark_contract.json \
  --candidates benchmark/desktop/desktop_model_candidates.json \
  --repository-root "$ROOT" >/dev/null
python3 benchmark/desktop/validate_macos_engine_selection.py \
  --candidates benchmark/desktop/desktop_model_candidates.json \
  --document benchmark/desktop/MACOS_ENGINE_SELECTION.md >/dev/null
python3 -m py_compile \
  benchmark/desktop/run_funasr_benchmark.py \
  apps/desktop/tool/processing_sidecar/launcher.py \
  apps/desktop/tool/processing_sidecar/worker.py \
  apps/desktop/tool/processing_sidecar/contract_fixture.py

EVIDENCE=benchmark/desktop/evidence/macos-sherpa-1.13.4
if [[ -f "$EVIDENCE/index.json" ]]; then
  python3 benchmark/desktop/validate_desktop_evidence.py \
    --contract benchmark/desktop/desktop_benchmark_contract.json \
    --evidence-root "$EVIDENCE" >/dev/null
fi
if [[ -f "$EVIDENCE/offline-vertical-slice.json" ]]; then
  python3 benchmark/desktop/validate_offline_vertical_slice.py \
    --evidence "$EVIDENCE/offline-vertical-slice.json" \
    --export "$EVIDENCE/offline-vertical-slice.vtt" >/dev/null
fi
if [[ -f "$EVIDENCE/cancellation/cancellation.json" ]]; then
  python3 benchmark/desktop/validate_cancellation_probe.py \
    --evidence "$EVIDENCE/cancellation/cancellation.json" >/dev/null
fi

echo "Desktop benchmark contract passed."
