#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DART_FILE="$ROOT/lib/app/contracts/audio_contract.dart"
KOTLIN_FILE="$(find "$ROOT/android/app/src/main/kotlin" -type f -path '*/contracts/AudioContract.kt' | head -n1)"

if [[ -z "$KOTLIN_FILE" || ! -f "$KOTLIN_FILE" ]]; then
  echo "Audio contract check failed: Kotlin AudioContract.kt not found."
  exit 1
fi

clean_val() {
  echo "$1" | sed -E "s/^[[:space:]]+|[[:space:]]+$//g" | tr -d "'\";"
}

extract_dart() {
  local key="$1"
  local value
  value="$(perl -0ne "if (/static const [^;]* ${key}\\s*=\\s*([^;]+);/s) { print \$1 }" "$DART_FILE")"
  clean_val "$value"
}

extract_kotlin() {
  local key="$1"
  local line
  line="$(rg "const val ${key} =" "$KOTLIN_FILE")"
  clean_val "$(echo "$line" | cut -d '=' -f2-)"
}

pairs=(
  "recorderChannel:RECORDER_CHANNEL"
  "transcriptionEventsChannel:TRANSCRIPTION_EVENTS_CHANNEL"
  "eventTypeSegment:EVENT_TYPE_SEGMENT"
  "eventTypeDegradation:EVENT_TYPE_DEGRADATION"
  "eventTypeSessionStarted:EVENT_TYPE_SESSION_STARTED"
  "eventTypeSessionStopped:EVENT_TYPE_SESSION_STOPPED"
  "recordingDirName:RECORDING_DIR_NAME"
  "recordingExtension:RECORDING_EXTENSION"
  "realtimeRecordingExtension:REALTIME_RECORDING_EXTENSION"
  "sampleRateHz:SAMPLE_RATE_HZ"
  "bitRate:BIT_RATE"
  "channelCount:CHANNEL_COUNT"
  "containerFormat:CONTAINER_FORMAT"
  "codec:CODEC"
)

failed=0
for pair in "${pairs[@]}"; do
  dart_key="${pair%%:*}"
  kotlin_key="${pair##*:}"

  dart_val="$(extract_dart "$dart_key")"
  kotlin_val="$(extract_kotlin "$kotlin_key")"

  if [[ "$dart_val" != "$kotlin_val" ]]; then
    echo "MISMATCH: $dart_key=$dart_val vs $kotlin_key=$kotlin_val"
    failed=1
  fi
done

if [[ "$failed" -eq 1 ]]; then
  echo "Audio contract check failed."
  exit 1
fi

echo "Audio contract check passed."
