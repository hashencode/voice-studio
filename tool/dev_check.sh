#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 tool/build_cache_guard.py

WITH_BUILD=false
if [[ "${1:-}" == "--with-build" ]]; then
  WITH_BUILD=true
fi

echo "[1/15] Audio contract check"
./tool/check_audio_contract.sh

echo "[2/15] Runtime contract check"
./tool/check_runtime_contract.sh

echo "[3/15] Privacy contract check"
./tool/check_privacy_contract.sh

echo "[4/15] S2 Mobile Core scope contract"
python3 -m unittest tool/test_validate_s2_mobile_core_scope.py
python3 tool/validate_s2_mobile_core_scope.py

echo "[5/15] S3 speaker admission contract"
python3 -m unittest \
  benchmark/test_prepare_speaker_diarization_fixtures.py \
  benchmark/test_evaluate_speaker_diarization.py \
  benchmark/test_validate_speaker_diarization_candidates.py
python3 benchmark/evaluate_speaker_diarization.py
python3 benchmark/validate_speaker_diarization_candidates.py

echo "[6/15] Paired-PC provider protocol contract"
python3 -m unittest tool/test_validate_meeting_intelligence_provider_contract.py
python3 tool/validate_meeting_intelligence_provider_contract.py

echo "[7/15] S3 productization truth contract"
python3 -m unittest tool/test_validate_s3_productization_scope.py
python3 tool/validate_s3_productization_scope.py

echo "[8/15] Flutter analyze"
flutter analyze

echo "[9/15] Flutter test"
flutter test

echo "[10/15] Timestamp fixture contract"
python3 -m unittest benchmark/test_evaluate_transcript_timestamps.py
python3 benchmark/evaluate_transcript_timestamps.py \
  --predictions benchmark/audio/timestamp_evaluator_selftest_predictions.json \
  --allow-provisional >/dev/null

echo "[11/15] ASR model-admission contract"
python3 -m unittest \
  benchmark/test_prepare_asr_candidate.py \
  benchmark/test_validate_asr_model_candidates.py \
  benchmark/test_evaluate_online_transducer_candidate.py
python3 benchmark/validate_asr_model_candidates.py

echo "[12/15] ITN fail-closed contract"
python3 -m unittest benchmark/test_validate_itn_assets.py
python3 benchmark/validate_itn_assets.py

echo "[13/15] Speech enhancement manifest contract"
python3 -m unittest benchmark/test_evaluate_s2_enhancement.py
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path.cwd()
manifest = json.loads(
    (root / "benchmark/audio/s2_noise_manifest.json").read_text(encoding="utf-8")
)
model = manifest["model"]
asset = root / model["packagedPath"]
assert manifest["schemaVersion"] == 1
assert manifest["productGate"]["verified"] is False
assert manifest["productGate"]["reason"] == "enhancement_preregistered_gates_failed"
assert len(manifest["cases"]) == 5
assert hashlib.sha256(asset.read_bytes()).hexdigest() == model["sha256"]
assert asset.stat().st_size == model["bytes"]
assert (root / model["licensePath"]).is_file()
assert (root / manifest["generation"]["script"]).is_file()
PY

echo "[14/15] Meeting flow harness contract"
test -f integration_test/meeting_offline_flow_test.dart
test -f integration_test/meeting_recovery_flow_test.dart
test -f integration_test/meeting_intelligence_flow_test.dart
test -x tool/run_meeting_flow_smoke.sh
test -x tool/run_deepseek_meeting_smoke.sh
test -f android/app/src/androidTest/AndroidManifest.xml
test -f android/app/src/androidTest/java/com/voice2text/app/test/ShareReceiverActivity.java

if [[ "$WITH_BUILD" == "true" ]]; then
  echo "[15/15] Flutter build apk --debug"
  flutter build apk --debug
else
  echo "[15/15] Skipped build (pass --with-build to enable)"
fi

echo "dev_check finished."
