#!/usr/bin/env bash
set -euo pipefail

electron_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"
worker_root="$electron_root/resources/worker"
authority="$repository_root/packages/desktop_sherpa_worker/assets/processing/frozen_sherpa_macos_arm64.json"
sensevoice_authority="$repository_root/packages/desktop_sherpa_worker/assets/processing/frozen_sensevoice_macos_arm64.json"
sensevoice_lock="$electron_root/assets/processing/frozen_sensevoice_macos_arm64.lock.json"
resources_root="$electron_root/resources"

bun "$electron_root/scripts/assert-worker-resource-host.ts"
python3 "$repository_root/tool/build_cache_guard.py"
mkdir -p "$resources_root"
if [[ -L "$worker_root" ]] || [[ -e "$worker_root" && ! -d "$worker_root" ]]; then
  echo "worker resource target must be a private directory" >&2
  exit 1
fi
staging_root="$(mktemp -d "$resources_root/.worker-staging.XXXXXX")"
download_root="$(mktemp -d "/tmp/voice2text-electron-sherpa.XXXXXX")"
cleanup() {
  if [[ -n "${staging_root:-}" && -d "$staging_root" && ! -L "$staging_root" ]]; then
    rm -rf -- "$staging_root"
  fi
  if [[ -n "${download_root:-}" && -d "$download_root" && ! -L "$download_root" ]]; then
    download_real="$(realpath "$download_root")"
    case "$download_real" in
      /private/tmp/voice2text-electron-sherpa.*|/tmp/voice2text-electron-sherpa.*)
        rm -rf -- "$download_root"
        ;;
      *)
        echo "refusing to clean unexpected download root: $download_real" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$staging_root/bin" "$staging_root/runtime"

dart compile exe \
  "$repository_root/packages/desktop_sherpa_worker/bin/desktop_sherpa_worker.dart" \
  -o "$staging_root/bin/desktop_sherpa_worker"
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$staging_root/bin/desktop_sherpa_worker"
codesign --force --sign - "$staging_root/bin/desktop_sherpa_worker"
dart compile exe \
  "$repository_root/packages/desktop_sherpa_worker/bin/desktop_sensevoice_caption_worker.dart" \
  -o "$staging_root/bin/desktop_sensevoice_caption_worker"
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$staging_root/bin/desktop_sensevoice_caption_worker"
codesign --force --sign - "$staging_root/bin/desktop_sensevoice_caption_worker"
clang -O2 \
  "$repository_root/packages/desktop_sherpa_worker/native/macos/native_process_group_launcher.c" \
  -o "$staging_root/bin/native_process_group_launcher"

cd "$electron_root"
bun scripts/materialize-frozen-sherpa-resources.ts \
  "$authority" \
  "$staging_root" \
  "$repository_root/pubspec.lock" \
  "$download_root" \
  "$sensevoice_authority" \
  "$sensevoice_lock"
for runtime in "$staging_root"/runtime/*.dylib; do
  chmod 755 "$runtime"
  codesign --force --sign - "$runtime"
done
chmod 755 "$staging_root"/bin/*
if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" ]] &&
  [[ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    "$staging_root/bin/desktop_sherpa_worker" \
    "$staging_root/bin/desktop_sensevoice_caption_worker" \
    "$staging_root/bin/native_process_group_launcher"
  for runtime in "$staging_root"/runtime/*.dylib; do
    codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" "$runtime"
  done
fi
bun scripts/write-worker-manifest.ts "$staging_root"

bash "$electron_root/scripts/publish-worker-resources.sh" \
  "$staging_root" \
  "$worker_root"
staging_root=""
