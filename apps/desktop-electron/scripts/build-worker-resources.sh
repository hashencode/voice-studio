#!/usr/bin/env bash
set -euo pipefail

electron_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$electron_root/../.." && pwd)"
worker_root="$electron_root/resources/worker"

python3 "$repository_root/tool/build_cache_guard.py"
mkdir -p "$worker_root/bin" "$worker_root/runtime"
"$repository_root/apps/desktop/tool/build_native_worker.sh" \
  "$worker_root/bin" \
  "$worker_root/runtime"
cd "$electron_root"
bun scripts/write-worker-manifest.ts "$worker_root"
