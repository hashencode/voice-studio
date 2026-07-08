#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP_ID="${APP_ID:-com.voice2text.app}"
SEGMENT_WINDOW_MS="${SEGMENT_WINDOW_MS:-12000}"
RESULT_DIR="$ROOT/build/asr_benchmark/results"
LOG_DIR="$ROOT/build/asr_benchmark/logs"

detect_device_id() {
  local requested="${1:-}"

  if [[ -n "${DEVICE_ID:-}" ]]; then
    echo "$DEVICE_ID"
    return
  fi

  if [[ -n "$requested" ]]; then
    echo "$requested"
    return
  fi

  if ! command -v adb >/dev/null 2>&1; then
    echo "adb is not available on PATH." >&2
    exit 1
  fi

  local devices
  devices="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  local count
  count="$(printf '%s\n' "$devices" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "$count" == "1" ]]; then
    printf '%s\n' "$devices" | sed '/^$/d'
    return
  fi

  if [[ "$count" == "0" ]]; then
    echo "No online Android device found. Start an emulator or connect a device, then retry." >&2
  else
    echo "Multiple online Android devices found. Set DEVICE_ID or pass a device serial:" >&2
    printf '%s\n' "$devices" | sed '/^$/d;s/^/  /' >&2
  fi
  exit 1
}

DEVICE_ID="$(detect_device_id "${1:-}")"

mkdir -p "$RESULT_DIR" "$LOG_DIR"

echo "[1/6] Checking device: $DEVICE_ID"
adb -s "$DEVICE_ID" get-state >/dev/null

if [[ -n "${MODEL_IDS:-}" ]]; then
  echo "[2/6] Downloading selected models: $MODEL_IDS"
  # shellcheck disable=SC2086
  "$ROOT/benchmark/download_asr_benchmark_models.sh" $MODEL_IDS
else
  echo "[2/6] Using models already present under build/asr_benchmark/models"
fi

echo "[3/6] Building and installing debug APK"
flutter build apk --debug >/dev/null
adb -s "$DEVICE_ID" install -r "$ROOT/build/app/outputs/flutter-apk/app-debug.apk" >/dev/null

echo "[4/6] Installing benchmark assets"
"$ROOT/benchmark/install_asr_benchmark_assets.sh" "$DEVICE_ID" "$APP_ID"

echo "[5/6] Running native benchmark activity"
log_file="$LOG_DIR/asr-benchmark-$(date +%Y%m%d-%H%M%S).log"
adb -s "$DEVICE_ID" shell am force-stop "$APP_ID" >/dev/null || true
adb -s "$DEVICE_ID" shell "run-as '$APP_ID' rm -f files/asr_benchmark/status.json" >/dev/null
adb -s "$DEVICE_ID" shell am start \
  -n "$APP_ID/com.voice2text.app.benchmark.AsrBenchmarkActivity" \
  --ei segmentWindowMs "$SEGMENT_WINDOW_MS" | tee "$log_file"

deadline=$((SECONDS + ${ASR_BENCHMARK_TIMEOUT_SECONDS:-1800}))
remote_result=""
last_progress_line=""
while [[ "$SECONDS" -lt "$deadline" ]]; do
  status_json="$(adb -s "$DEVICE_ID" exec-out run-as "$APP_ID" cat files/asr_benchmark/status.json 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$status_json" ]]; then
    echo "$status_json" > "$LOG_DIR/latest-status.json"
    status="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' <<<"$status_json" 2>/dev/null || true)"
    progress_line="$(python3 -c 'import json,sys
s=json.load(sys.stdin)
parts=[]
completed=s.get("completedPairs")
total=s.get("totalPairs")
stage=s.get("currentStage")
model=s.get("currentModelId")
profile=s.get("currentProfileId")
audio=s.get("currentAudioCaseId")
if completed is not None and total is not None:
    parts.append(f"{completed}/{total}")
if stage:
    parts.append(str(stage))
if model:
    parts.append(str(model))
if profile:
    parts.append(str(profile))
if audio:
    parts.append(str(audio))
print(" | ".join(parts))' <<<"$status_json" 2>/dev/null || true)"
    if [[ -n "$progress_line" && "$progress_line" != "$last_progress_line" ]]; then
      echo "Progress: $progress_line"
      last_progress_line="$progress_line"
    fi
    if [[ "$status" == "done" ]]; then
      remote_result="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("reportPath",""))' <<<"$status_json")"
      break
    fi
    if [[ "$status" == "failed" ]]; then
      echo "$status_json"
      echo "Benchmark failed. Log: $log_file"
      exit 1
    fi
    if [[ "$status" == "running" ]]; then
      if ! adb -s "$DEVICE_ID" shell pidof "$APP_ID" >/dev/null 2>&1; then
        echo "Benchmark process exited while status was still running. Last status: $LOG_DIR/latest-status.json"
        exit 1
      fi
    fi
  fi
  sleep 5
done

if [[ -z "$remote_result" ]]; then
  echo "Benchmark timed out waiting for status. Last status: $LOG_DIR/latest-status.json"
  exit 1
fi

local_result="$RESULT_DIR/$(basename "$remote_result")"
echo "[6/6] Pulling result JSON"
adb -s "$DEVICE_ID" exec-out run-as "$APP_ID" cat "$remote_result" > "$local_result"

echo "Benchmark result: $local_result"
