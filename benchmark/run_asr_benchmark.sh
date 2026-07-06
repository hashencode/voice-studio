#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEVICE_ID="${DEVICE_ID:-${1:-emulator-5554}}"
APP_ID="${APP_ID:-com.voice2text.app}"
SEGMENT_WINDOW_MS="${SEGMENT_WINDOW_MS:-12000}"
RESULT_DIR="$ROOT/build/asr_benchmark/results"
LOG_DIR="$ROOT/build/asr_benchmark/logs"

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
adb -s "$DEVICE_ID" shell "run-as '$APP_ID' rm -f files/asr_benchmark/status.json" >/dev/null
adb -s "$DEVICE_ID" shell am start \
  -n "$APP_ID/com.voice2text.app.benchmark.AsrBenchmarkActivity" \
  --ei segmentWindowMs "$SEGMENT_WINDOW_MS" | tee "$log_file"

deadline=$((SECONDS + ${ASR_BENCHMARK_TIMEOUT_SECONDS:-1800}))
remote_result=""
while [[ "$SECONDS" -lt "$deadline" ]]; do
  status_json="$(adb -s "$DEVICE_ID" exec-out run-as "$APP_ID" cat files/asr_benchmark/status.json 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$status_json" ]]; then
    echo "$status_json" > "$LOG_DIR/latest-status.json"
    status="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' <<<"$status_json" 2>/dev/null || true)"
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
