#!/usr/bin/env bash
set -euo pipefail

electron_root="$(cd "$(dirname "$0")/../.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"
package_root="$repository_root/packages/desktop_macos_native"
configuration="${1:-release}"

python3 "$repository_root/tool/build_cache_guard.py"

case "$configuration" in
  debug)
    swift build --package-path "$package_root" --configuration debug
    ;;
  release)
    swift build --package-path "$package_root" --configuration release
    output_root="$electron_root/resources/native/macos/bin"
    mkdir -p "$output_root"
    cp "$package_root/.build/release/desktop_macos_native_helper" \
      "$output_root/desktop_macos_native_helper"
    chmod 700 "$output_root/desktop_macos_native_helper"
    codesign --force --sign - --timestamp=none \
      "$output_root/desktop_macos_native_helper"
    codesign --verify --strict "$output_root/desktop_macos_native_helper"
    ;;
  *)
    echo "unsupported helper build configuration: $configuration" >&2
    exit 64
    ;;
esac
