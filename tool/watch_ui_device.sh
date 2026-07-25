#!/usr/bin/env bash

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'USAGE'
Usage:
  ./tool/watch_ui_device.sh [device-id]

Environment:
  DEVICE_ID           Android device id. If omitted, uses the only attached adb device.
  DEBOUNCE_SECONDS    Stable period before action. Defaults to 60.
  POLL_SECONDS        File polling interval. Defaults to 2.
  RELOAD_CHECK_SECONDS Seconds to inspect flutter output after reload. Defaults to 12.
  PID_FILE            Flutter run pid file. Defaults to build/flutter-ui.pid.
  EXTRA_FLUTTER_ARGS  Extra args appended to flutter run.

Behavior:
  - lib/*.dart changes: hot reload after DEBOUNCE_SECONDS without new changes.
  - lib/main.dart changes: hot restart.
  - android/, assets/, pubspec.yaml, pubspec.lock changes: restart flutter run, rebuilding the app.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

DEVICE_ID="${1:-${DEVICE_ID:-}}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-60}"
POLL_SECONDS="${POLL_SECONDS:-2}"
RELOAD_CHECK_SECONDS="${RELOAD_CHECK_SECONDS:-12}"
PID_FILE="${PID_FILE:-build/flutter-ui.pid}"
LOG_DIR="build/watch"
RUN_LOG="$LOG_DIR/flutter-run-$(date +%Y%m%d-%H%M%S).log"
WATCHER_PID_FILE="${WATCHER_PID_FILE:-$LOG_DIR/watch-ui-device.pid}"

SNAPSHOT_BEFORE="$(mktemp "${TMPDIR:-/tmp}/voice2text-watch-before.XXXXXX")"
SNAPSHOT_AFTER="$(mktemp "${TMPDIR:-/tmp}/voice2text-watch-after.XXXXXX")"
PENDING_PATHS="$(mktemp "${TMPDIR:-/tmp}/voice2text-watch-pending.XXXXXX")"
RUNNER_PID=""

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer"
    exit 1
  fi
}

resolve_device_id() {
  if [[ -n "$DEVICE_ID" ]]; then
    return
  fi

  local devices
  devices="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  local count
  count="$(printf '%s\n' "$devices" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" == "1" ]]; then
    DEVICE_ID="$(printf '%s\n' "$devices" | sed '/^$/d' | head -n1)"
    return
  fi

  echo "Could not infer a single attached Android device."
  echo "Pass one explicitly, for example:"
  echo "  ./tool/watch_ui_device.sh 8PXCGQZPEQJNP7U8"
  echo
  adb devices
  exit 1
}

stat_one() {
  local path="$1"
  if stat -f "%m %z %N" "$path" >/dev/null 2>&1; then
    stat -f "%m %z %N" "$path"
  else
    stat -c "%Y %s %n" "$path"
  fi
}

write_snapshot() {
  local output="$1"
  local root
  {
    for root in lib android assets pubspec.yaml pubspec.lock analysis_options.yaml; do
      if [[ -f "$root" ]]; then
        printf '%s\0' "$root"
      elif [[ -d "$root" ]]; then
        find "$root" \
          \( \
            -path '*/.gradle/*' \
            -o -path '*/.kotlin/*' \
            -o -path '*/build/*' \
            -o -path '*/.cxx/*' \
            -o -path 'android/local.properties' \
          \) -prune \
          -o -type f -print0
      fi
    done
  } | while IFS= read -r -d '' path; do
    stat_one "$path" || true
  done | sort >"$output" || true
}

changed_paths() {
  local before="$1"
  local after="$2"
  { diff -u "$before" "$after" || true; } \
    | sed -nE 's/^[+-][0-9]+ [0-9]+ (.*)$/\1/p' \
    | sort -u
}

append_pending_paths() {
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/voice2text-watch-pending-merge.XXXXXX")"
  {
    if [[ -s "$PENDING_PATHS" ]]; then
      cat "$PENDING_PATHS"
    fi
    cat
  } | sed '/^$/d' | sort -u >"$tmp"
  mv "$tmp" "$PENDING_PATHS"
}

classify_pending_action() {
  local action="reload"
  local path
  while IFS= read -r path; do
    case "$path" in
      android/*|assets/*|pubspec.yaml|pubspec.lock)
        echo "rebuild"
        return
        ;;
      lib/main.dart)
        action="restart"
        ;;
      lib/*.dart)
        ;;
      *)
        action="reload"
        ;;
    esac
  done <"$PENDING_PATHS"
  echo "$action"
}

print_pending_summary() {
  local count
  count="$(sed '/^$/d' "$PENDING_PATHS" | wc -l | tr -d ' ')"
  echo "Detected $count changed path(s):"
  sed 's/^/  - /' "$PENDING_PATHS" | head -n 20
  if (( count > 20 )); then
    echo "  ... $((count - 20)) more"
  fi
}

flutter_pid() {
  if [[ -s "$PID_FILE" ]]; then
    sed -n '1p' "$PID_FILE"
  fi
}

register_watcher() {
  mkdir -p "$LOG_DIR"

  if [[ -s "$WATCHER_PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(sed -n '1p' "$WATCHER_PID_FILE")"
    if [[ -n "$existing_pid" && "$existing_pid" != "$$" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      echo "UI watcher already running: pid=$existing_pid"
      exit 0
    fi
  fi

  printf '%s\n' "$$" >"$WATCHER_PID_FILE"
}

start_flutter_run() {
  mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"
  rm -f "$PID_FILE"

  echo
  echo "Starting flutter run: device=$DEVICE_ID"
  echo "Log: $RUN_LOG"

  flutter_command=(
    flutter run
    -d "$DEVICE_ID" \
    --device-connection attached \
    --debug \
    --pid-file "$PID_FILE"
  )

  if [[ -n "${EXTRA_FLUTTER_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra_flutter_args=( ${EXTRA_FLUTTER_ARGS} )
    flutter_command+=( "${extra_flutter_args[@]}" )
  fi

  if command -v script >/dev/null 2>&1 && [[ "${USE_SCRIPT_TTY:-1}" != "0" ]]; then
    tail -f /dev/null | script -q /dev/null "${flutter_command[@]}" > >(tee -a "$RUN_LOG") 2>&1 &
  else
    "${flutter_command[@]}" </dev/null > >(tee -a "$RUN_LOG") 2>&1 &
  fi
  RUNNER_PID="$!"

  local waited=0
  while (( waited < 180 )); do
    if [[ -s "$PID_FILE" ]]; then
      echo "Flutter run is ready. pid=$(flutter_pid)"
      return 0
    fi
    if ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
      echo "flutter run exited before becoming ready. Fix the error above; watcher will retry on the next rebuild-triggering change."
      RUNNER_PID=""
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "Timed out waiting for flutter run pid file: $PID_FILE"
  return 1
}

stop_flutter_run() {
  local pid
  pid="$(flutter_pid || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "Stopping flutter run pid=$pid"
    kill "$pid" >/dev/null 2>&1 || true
  fi

  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
    kill "$RUNNER_PID" >/dev/null 2>&1 || true
    wait "$RUNNER_PID" >/dev/null 2>&1 || true
  fi
  RUNNER_PID=""
  rm -f "$PID_FILE"
}

send_flutter_signal() {
  local signal="$1"
  local pid
  pid="$(flutter_pid || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "No active flutter run session; starting one instead."
    start_flutter_run || true
    return
  fi

  kill "-$signal" "$pid"
}

log_since_line() {
  local start_line="$1"
  local next_line=$((start_line + 1))
  tail -n +"$next_line" "$RUN_LOG" 2>/dev/null || true
}

hot_reload() {
  local start_line
  start_line="$(wc -l <"$RUN_LOG" | tr -d ' ')"
  echo "Triggering hot reload..."
  send_flutter_signal USR1
  sleep "$RELOAD_CHECK_SECONDS"

  local recent
  recent="$(log_since_line "$start_line")"
  if printf '%s\n' "$recent" | rg -i "hot reload was rejected|reload rejected|try hot restart|reassemble failed" >/dev/null 2>&1; then
    echo "Hot reload was rejected; trying hot restart."
    send_flutter_signal USR2
  elif printf '%s\n' "$recent" | rg -i "failed to compile|try again after fixing|error:" >/dev/null 2>&1; then
    echo "Hot reload hit a compile error. Fix it; the watcher will try again after the next quiet period."
  fi
}

hot_restart() {
  echo "Triggering hot restart..."
  send_flutter_signal USR2
}

rebuild_and_rerun() {
  echo "Rebuild-required change detected; restarting flutter run."
  stop_flutter_run
  start_flutter_run || true
}

perform_pending_action() {
  if [[ ! -s "$PENDING_PATHS" ]]; then
    return
  fi

  print_pending_summary
  local action
  action="$(classify_pending_action)"
  case "$action" in
    rebuild)
      rebuild_and_rerun
      ;;
    restart)
      hot_restart
      ;;
    *)
      hot_reload
      ;;
  esac

  : >"$PENDING_PATHS"
}

cleanup() {
  stop_flutter_run
  if [[ -s "$WATCHER_PID_FILE" && "$(sed -n '1p' "$WATCHER_PID_FILE")" == "$$" ]]; then
    rm -f "$WATCHER_PID_FILE"
  fi
  rm -f "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER" "$PENDING_PATHS"
}

validate_positive_integer DEBOUNCE_SECONDS "$DEBOUNCE_SECONDS"
validate_positive_integer POLL_SECONDS "$POLL_SECONDS"
validate_positive_integer RELOAD_CHECK_SECONDS "$RELOAD_CHECK_SECONDS"
resolve_device_id
register_watcher
trap cleanup EXIT INT TERM

echo "Watching UI device workflow"
echo "Device: $DEVICE_ID"
echo "Debounce: ${DEBOUNCE_SECONDS}s"
echo "Poll: ${POLL_SECONDS}s"
echo
echo "Press Ctrl-C to stop. Dart edits hot reload; native/config/assets edits rebuild."

write_snapshot "$SNAPSHOT_BEFORE"
start_flutter_run || true

last_change_epoch=0
while true; do
  sleep "$POLL_SECONDS"

  write_snapshot "$SNAPSHOT_AFTER"
  if ! cmp -s "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER"; then
    changed_paths "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER" | append_pending_paths
    cp "$SNAPSHOT_AFTER" "$SNAPSHOT_BEFORE"
    last_change_epoch="$(date +%s)"
    echo "Change detected. Waiting for ${DEBOUNCE_SECONDS}s of quiet..."
    continue
  fi

  if [[ -s "$PENDING_PATHS" ]]; then
    now="$(date +%s)"
    if (( now - last_change_epoch >= DEBOUNCE_SECONDS )); then
      perform_pending_action
    fi
  fi
done
