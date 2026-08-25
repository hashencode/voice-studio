#!/usr/bin/env bash
set -euo pipefail

electron_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"
resources_root="$electron_root/resources"
worker_root="$resources_root/worker"
sherpa_authority="$repository_root/packages/desktop_sherpa_worker/assets/processing/frozen_sherpa_macos_arm64.json"
sensevoice_authority="$repository_root/packages/desktop_sherpa_worker/assets/processing/frozen_sensevoice_macos_arm64.json"
sensevoice_lock="$electron_root/assets/processing/frozen_sensevoice_macos_arm64.lock.json"

bun "$electron_root/scripts/assert-worker-resource-host.ts"
python3 "$repository_root/tool/build_cache_guard.py"
bun "$electron_root/scripts/verify-worker-resources.ts" "$worker_root"

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

cp -R "$worker_root/." "$staging_root/"
dart compile exe \
  "$repository_root/packages/desktop_sherpa_worker/bin/desktop_sensevoice_caption_worker.dart" \
  -o "$staging_root/bin/desktop_sensevoice_caption_worker"
LC_ALL=C perl -pi -e \
  's{(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)}{$1stable$2}g' \
  "$staging_root/bin/desktop_sensevoice_caption_worker"
codesign --force --sign - "$staging_root/bin/desktop_sensevoice_caption_worker"

cd "$electron_root"
VOICE2TEXT_LIVE_CAPTION_ONLY=1 \
  bun scripts/materialize-frozen-sherpa-resources.ts \
  "$sherpa_authority" \
  "$staging_root" \
  "$repository_root/pubspec.lock" \
  "$download_root" \
  "$sensevoice_authority" \
  "$sensevoice_lock"
chmod 755 "$staging_root/bin/desktop_sensevoice_caption_worker"
bun scripts/write-worker-manifest.ts "$staging_root"
rm -rf -- "$staging_root/models"
bun scripts/verify-worker-resources.ts "$staging_root"

bash "$electron_root/scripts/publish-worker-resources.sh" \
  "$staging_root" \
  "$worker_root"
staging_root=""
