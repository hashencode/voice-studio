#!/usr/bin/env bash

set -eo pipefail

RUN_DELETE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/clean_flutter_android_artifacts.sh           # Dry run
  ./scripts/clean_flutter_android_artifacts.sh --run     # Delete matched directories
  ./scripts/clean_flutter_android_artifacts.sh --run -y  # Delete without prompt

What it removes:
  - <flutter-project>/build
  - <flutter-project>/.dart_tool/flutter_build
  - <flutter-project>/android/.gradle
  - <flutter-project>/android/build
  - <flutter-project>/android/.kotlin
  - <flutter-project>/android/.cxx
  - <flutter-project>/android/captures
  - <flutter-project>/android/app/.cxx
  - <flutter-project>/android/app/.externalNativeBuild

The script only targets generated Android/Flutter build artifacts that can be
recreated later. It does not touch source code, Gradle wrapper files, or local
configuration such as android/local.properties.
EOF
}

human_size_from_kb() {
  awk -v kb="$1" '
    function human(value, units, i) {
      split("KB MB GB TB PB", units, " ")
      i = 1
      while (value >= 1024 && i < length(units)) {
        value /= 1024
        i++
      }
      return (value >= 10 || i == 1) ? sprintf("%.0f%s", value, units[i]) : sprintf("%.1f%s", value, units[i])
    }
    BEGIN {
      print human(kb, "", 1)
    }
  '
}

confirm() {
  local prompt="$1"
  local reply

  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi

  read -r -p "$prompt [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

declare -a TARGETS=()

has_target() {
  local existing

  for existing in "${TARGETS[@]}"; do
    if [[ "$existing" == "$1" ]]; then
      return 0
    fi
  done

  return 1
}

add_target() {
  local path="$1"

  if [[ ! -e "$path" ]]; then
    return
  fi

  if has_target "$path"; then
    return
  fi

  TARGETS+=("$path")
}

collect_targets() {
  local pubspec
  local project_dir

  while IFS= read -r -d '' pubspec; do
    project_dir="$(dirname "$pubspec")"

    add_target "$project_dir/build"
    add_target "$project_dir/.dart_tool/flutter_build"
    add_target "$project_dir/android/.gradle"
    add_target "$project_dir/android/build"
    add_target "$project_dir/android/.kotlin"
    add_target "$project_dir/android/.cxx"
    add_target "$project_dir/android/captures"
    add_target "$project_dir/android/app/.cxx"
    add_target "$project_dir/android/app/.externalNativeBuild"
  done < <(
    find . \
      -type d \( -name .git -o -name .dart_tool \) -prune \
      -o -type f -name pubspec.yaml -print0
  )
}

print_summary() {
  local total_kb=0
  local dir_kb
  local target
  local display_path

  if [[ "${#TARGETS[@]}" -eq 0 ]]; then
    echo "No generated Android/Flutter build artifacts were found."
    return
  fi

  echo "Matched directories:"

  for target in "${TARGETS[@]}"; do
    dir_kb="$(du -sk "$target" 2>/dev/null | awk '{print $1}')"
    dir_kb="${dir_kb:-0}"
    total_kb=$((total_kb + dir_kb))
    display_path="${target#./}"
    printf '  - %-45s %8s\n' "$display_path" "$(human_size_from_kb "$dir_kb")"
  done

  echo
  echo "Estimated reclaimable space: $(human_size_from_kb "$total_kb")"
}

delete_targets() {
  local target

  for target in "${TARGETS[@]}"; do
    rm -rf "$target"
    echo "Deleted: ${target#./}"
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_DELETE=1
      ;;
    -y|--yes)
      ASSUME_YES=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

collect_targets
print_summary

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ "$RUN_DELETE" -eq 0 ]]; then
  echo
  echo "Dry run only. Re-run with --run to remove these directories."
  exit 0
fi

echo
if ! confirm "Delete the directories above?"; then
  echo "Cancelled."
  exit 0
fi

delete_targets
echo
echo "Cleanup complete."
