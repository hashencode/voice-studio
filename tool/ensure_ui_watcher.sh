#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'USAGE'
Usage:
  ./tool/ensure_ui_watcher.sh

Starts ./tool/watch_ui_device.sh in the background only when:
  - a physical Android device is connected, and
  - watch_ui_device.sh is not already running.

Environment:
  DEVICE_ID  Optional explicit Android device id.
  FLAVOR     Optional Flutter flavor for the watcher. Defaults to ui.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

FLAVOR="${FLAVOR:-ui}"
WATCH_SCRIPT="$ROOT/tool/watch_ui_device.sh"
LOG_DIR="$ROOT/build/watch"
START_LOG="$LOG_DIR/ensure-ui-watcher-$(date +%Y%m%d-%H%M%S).log"
PID_FILE="$LOG_DIR/watch-ui-device.pid"
SCREEN_SESSION="${SCREEN_SESSION:-voice2text-ui-watch}"

pid_file_watcher_pid() {
  if [[ -s "$PID_FILE" ]]; then
    sed -n '1p' "$PID_FILE"
  fi
}

ps_watcher_pids() {
  ps -axo pid=,command= \
    | awk '
      /watch_ui_device\.sh/ && !/ensure_ui_watcher\.sh/ && !/awk / {
        print $1
      }
    '
}

running_watcher_pids() {
  local pid
  pid="$(pid_file_watcher_pid || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s\n' "$pid"
    return 0
  fi

  ps_watcher_pids | sed '/^$/d'
}

screen_session_running() {
  command -v screen >/dev/null 2>&1 || return 1
  screen -ls 2>/dev/null | awk -v session="$SCREEN_SESSION" '$0 ~ session { found = 1 } END { exit(found ? 0 : 1) }'
}

connected_devices() {
  adb devices | awk 'NR > 1 && $2 == "device" { print $1 }'
}

is_physical_device() {
  local device_id="$1"
  local qemu

  if [[ "$device_id" == emulator-* ]]; then
    return 1
  fi

  qemu="$(adb -s "$device_id" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
  [[ "$qemu" != "1" ]]
}

select_physical_device() {
  local device_id

  if [[ -n "${DEVICE_ID:-}" ]]; then
    if adb -s "$DEVICE_ID" get-state >/dev/null 2>&1 && is_physical_device "$DEVICE_ID"; then
      printf '%s\n' "$DEVICE_ID"
      return 0
    fi
    return 1
  fi

  while IFS= read -r device_id; do
    [[ -n "$device_id" ]] || continue
    if is_physical_device "$device_id"; then
      printf '%s\n' "$device_id"
      return 0
    fi
  done < <(connected_devices)

  return 1
}

if ! command -v adb >/dev/null 2>&1; then
  echo "No adb found; skipping UI watcher."
  exit 0
fi

running="$(running_watcher_pids | sed '/^$/d' | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
if [[ -n "$running" ]]; then
  echo "UI watcher already running: $running"
  exit 0
fi

if screen_session_running; then
  echo "UI watcher screen session already running: $SCREEN_SESSION"
  exit 0
fi

device_id="$(select_physical_device || true)"
if [[ -z "$device_id" ]]; then
  echo "No physical Android device connected; skipping UI watcher."
  exit 0
fi

mkdir -p "$LOG_DIR"
echo "Starting UI watcher for device=$device_id flavor=$FLAVOR"
echo "Log: $START_LOG"

if command -v screen >/dev/null 2>&1; then
  {
    echo "Starting detached screen session: $SCREEN_SESSION"
    echo "Screen log: $LOG_DIR/screenlog.0"
  } >"$START_LOG"
  (
    cd "$LOG_DIR"
    screen -dmS "$SCREEN_SESSION" -L bash -lc 'cd "$1"; exec env FLAVOR="$2" WATCHER_PID_FILE="$3" ./tool/watch_ui_device.sh "$4"' \
      _ "$ROOT" "$FLAVOR" "$PID_FILE" "$device_id"
  )
else
  nohup bash -c 'cd "$1"; exec env FLAVOR="$2" WATCHER_PID_FILE="$3" ./tool/watch_ui_device.sh "$4"' \
    _ "$ROOT" "$FLAVOR" "$PID_FILE" "$device_id" >>"$START_LOG" 2>&1 </dev/null &
  watcher_pid="$!"
  printf '%s\n' "$watcher_pid" >"$PID_FILE"
fi

sleep 2
actual_pid="$(pid_file_watcher_pid || true)"
if [[ -n "$actual_pid" ]] && kill -0 "$actual_pid" >/dev/null 2>&1; then
  echo "UI watcher started: pid=$actual_pid"
elif screen_session_running; then
  echo "UI watcher screen session started: $SCREEN_SESSION"
else
  echo "UI watcher exited immediately. Check log: $START_LOG"
fi
