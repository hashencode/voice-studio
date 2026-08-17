#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"

python3 tool/build_cache_guard.py

WITH_BUILD=false
if [[ "${1:-}" == "--with-build" ]]; then
  WITH_BUILD=true
fi

echo "[1/19] Audio contract check"
./tool/check_audio_contract.sh

echo "[2/19] Runtime contract check"
./tool/check_runtime_contract.sh

echo "[3/19] Privacy contract check"
./tool/check_privacy_contract.sh

echo "[4/19] S2 Mobile Core scope contract"
python3 -m unittest tool/test_validate_s2_mobile_core_scope.py
python3 tool/validate_s2_mobile_core_scope.py

echo "[5/19] S3 speaker admission contract"
python3 -m unittest \
  benchmark/test_prepare_speaker_diarization_fixtures.py \
  benchmark/test_evaluate_speaker_diarization.py \
  benchmark/test_validate_speaker_diarization_candidates.py \
  benchmark/test_validate_speaker_diarization_final_diagnostic.py
python3 benchmark/evaluate_speaker_diarization.py
python3 benchmark/validate_speaker_diarization_candidates.py

echo "[6/19] Paired-PC provider protocol contract"
python3 -m unittest tool/test_validate_meeting_intelligence_provider_contract.py
python3 tool/validate_meeting_intelligence_provider_contract.py

echo "[7/19] Companion media transfer protocol contract"
python3 -m unittest tool/test_validate_companion_media_transfer_contract.py
python3 tool/validate_companion_media_transfer_contract.py

echo "[8/19] S3 productization truth contract"
python3 -m unittest tool/test_validate_s3_productization_scope.py
python3 tool/validate_s3_productization_scope.py

echo "[9/19] Mobile Flutter layout contract"
python3 -m unittest tool/test_validate_mobile_flutter_layout.py
python3 tool/validate_mobile_flutter_layout.py

echo "[10/19] Electron Desktop removal truth contract"
python3 -m unittest \
  tool/test_validate_electron_desktop_scope.py \
  tool/test_validate_electron_desktop_removal.py
python3 tool/validate_electron_desktop_scope.py

echo "[11/19] Desktop foundation contract"
./tool/check_desktop_foundation.sh

echo "[12/19] Desktop benchmark contract"
./tool/check_desktop_benchmark.sh

echo "[13/19] Shared Dart workspace contract"
dart pub workspace list
python3 tool/build_cache_guard.py
dart test \
  packages/companion_protocol \
  packages/desktop_sherpa_worker \
  packages/meeting_core \
  packages/processing_contracts \
  packages/meeting_workflows
python3 tool/build_cache_guard.py
flutter test packages/meeting_storage/test

echo "[14/19] Flutter analyze"
python3 tool/build_cache_guard.py
(
  cd "$MOBILE_ROOT"
  flutter analyze
)

echo "[15/19] Flutter test"
python3 tool/build_cache_guard.py
(
  cd "$MOBILE_ROOT"
  flutter test
)

echo "[16/19] Timestamp fixture contract"
python3 -m unittest benchmark/test_evaluate_transcript_timestamps.py
python3 benchmark/evaluate_transcript_timestamps.py \
  --predictions benchmark/audio/timestamp_evaluator_selftest_predictions.json \
  --allow-provisional >/dev/null

echo "[17/19] ASR model-admission contract"
python3 -m unittest \
  benchmark/test_prepare_asr_candidate.py \
  benchmark/test_validate_asr_model_candidates.py \
  benchmark/test_evaluate_online_transducer_candidate.py
python3 benchmark/validate_asr_model_candidates.py

echo "[18/19] ITN fail-closed contract"
python3 -m unittest benchmark/test_validate_itn_assets.py
python3 benchmark/validate_itn_assets.py

echo "[19/19] Speech enhancement manifest contract"
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

echo "[mobile flow] Meeting flow harness contract"
test -f "$MOBILE_ROOT/integration_test/meeting_offline_flow_test.dart"
test -f "$MOBILE_ROOT/integration_test/meeting_recovery_flow_test.dart"
test -f "$MOBILE_ROOT/integration_test/meeting_intelligence_flow_test.dart"
test -f "$MOBILE_ROOT/integration_test/u8_companion_lan_smoke_test.dart"
test -x tool/run_meeting_flow_smoke.sh
test -x tool/run_deepseek_meeting_smoke.sh
test -f "$MOBILE_ROOT/android/app/src/androidTest/AndroidManifest.xml"
test -f "$MOBILE_ROOT/android/app/src/androidTest/java/com/voice2text/app/test/ShareReceiverActivity.java"

if [[ "$WITH_BUILD" == "true" ]]; then
  echo "[mobile build] Flutter build apk --debug"
  python3 tool/build_cache_guard.py
  (
    cd "$MOBILE_ROOT"
    flutter build apk --debug
  )
else
  echo "[mobile build] Skipped build (pass --with-build to enable)"
fi

echo "dev_check finished."
