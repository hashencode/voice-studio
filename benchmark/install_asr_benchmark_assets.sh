#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEVICE_ID="${1:-emulator-5554}"
APP_ID="${2:-com.voice2text.app}"
LOCAL_ROOT="$ROOT/build/asr_benchmark"
STAGING="$LOCAL_ROOT/staging"
REMOTE_TMP="/data/local/tmp/voice2text-asr-benchmark"
MANIFEST_FILE="${BENCHMARK_MANIFEST_FILE:-$ROOT/benchmark/asr_benchmark_manifest.json}"
PROFILES_FILE="${BENCHMARK_PROFILES_FILE:-$ROOT/benchmark/asr_benchmark_profiles.json}"
AUDIO_ROOT="${BENCHMARK_AUDIO_ROOT:-$ROOT/benchmark}"

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path"
    exit 1
  fi
}

adb -s "$DEVICE_ID" get-state >/dev/null

require_file "$MANIFEST_FILE"
require_file "$PROFILES_FILE"
require_file "$ROOT/assets/sherpa/onnx/silero-vad.onnx"

if [[ ! -d "$LOCAL_ROOT/models" ]] || [[ -z "$(find "$LOCAL_ROOT/models" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]]; then
  echo "No extracted models found under $LOCAL_ROOT/models"
  echo "Run: ./benchmark/download_asr_benchmark_models.sh <model-id...>"
  exit 1
fi

rm -rf "$STAGING"
mkdir -p "$STAGING"
if [[ -n "${MODEL_IDS:-}" || -n "${AUDIO_CASES:-}" || -n "${BENCHMARK_MODES:-}" ]]; then
  python3 - "$MANIFEST_FILE" "$STAGING/manifest.json" "${MODEL_IDS:-}" "${AUDIO_CASES:-}" "${BENCHMARK_MODES:-}" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
model_ids = {item for item in sys.argv[3].split() if item}
audio_cases = {item for item in sys.argv[4].split() if item}
benchmark_modes = [item for item in sys.argv[5].split() if item]
manifest = json.loads(source.read_text())
if model_ids:
    manifest["models"] = [m for m in manifest["models"] if m["id"] in model_ids]
if audio_cases:
    manifest["audioCases"] = [a for a in manifest["audioCases"] if a["id"] in audio_cases]
if benchmark_modes:
    manifest["modes"] = benchmark_modes
target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
PY
else
  cp "$MANIFEST_FILE" "$STAGING/manifest.json"
fi

python3 - "$PROFILES_FILE" "$STAGING/profiles.json" "${PROFILE_IDS:-}" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
profile_ids = [item for item in sys.argv[3].split() if item]
payload = json.loads(source.read_text())
available = {profile["id"]: profile for profile in payload["profiles"]}
if profile_ids:
    missing = [profile_id for profile_id in profile_ids if profile_id not in available]
    if missing:
        raise SystemExit(f"Unknown profile id(s): {', '.join(missing)}")
    selected = profile_ids
else:
    selected = payload.get("defaultProfileIds") or [profile["id"] for profile in payload["profiles"]]
payload["profiles"] = [available[profile_id] for profile_id in selected]
payload["selectedProfileIds"] = selected
target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

mkdir -p "$STAGING/models"
python3 - "$STAGING/manifest.json" "$LOCAL_ROOT/models" "$STAGING/models" <<'PY'
import json
import sys
import shutil
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
model_root = Path(sys.argv[2])
staging_root = Path(sys.argv[3])
for model in manifest["models"]:
    source_dir = model_root / model["extractedDir"]
    target_dir = staging_root / model["extractedDir"]
    if not source_dir.is_dir():
        raise SystemExit(f"Missing model directory: {source_dir}")
    for relative in model["requiredFiles"].values():
        rel = Path(relative)
        if rel.is_absolute() or ".." in rel.parts:
            raise SystemExit(f"Unsafe model file path: {relative}")
        source = source_dir / rel
        target = target_dir / rel
        if not source.is_file():
            raise SystemExit(f"Missing required model file: {source}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
PY
python3 - "$STAGING/manifest.json" "$AUDIO_ROOT" "$STAGING" <<'PY'
import json
import sys
import shutil
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
audio_root = Path(sys.argv[2])
staging_root = Path(sys.argv[3])
for audio_case in manifest["audioCases"]:
    for key in ("wav", "reference"):
        rel = Path(audio_case[key])
        if rel.is_absolute() or ".." in rel.parts:
            raise SystemExit(f"Unsafe audio file path: {audio_case[key]}")
        source = audio_root / rel
        target = staging_root / rel
        if not source.is_file():
            raise SystemExit(f"Missing benchmark audio file: {source}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
PY
mkdir -p "$STAGING/vad"
cp "$ROOT/assets/sherpa/onnx/silero-vad.onnx" "$STAGING/vad/silero-vad.onnx"

adb -s "$DEVICE_ID" shell "rm -rf '$REMOTE_TMP'"
adb -s "$DEVICE_ID" push "$STAGING" "$REMOTE_TMP" >/dev/null
adb -s "$DEVICE_ID" shell "run-as '$APP_ID' sh -c 'rm -rf files/asr_benchmark && mkdir -p files/asr_benchmark'"
adb -s "$DEVICE_ID" shell "run-as '$APP_ID' sh -c 'cp -R $REMOTE_TMP/. files/asr_benchmark/'"
adb -s "$DEVICE_ID" shell "rm -rf '$REMOTE_TMP'"

echo "Benchmark assets installed into $APP_ID files/asr_benchmark on $DEVICE_ID"
