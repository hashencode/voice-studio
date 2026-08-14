#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
electron_root="${repository_root}/apps/desktop-electron"

python3 "${repository_root}/tool/build_cache_guard.py" --wait-for-idle

cd "${electron_root}"
bun ci
bun run check
bun run package
bun run smoke:package

RUN_PACKAGED_SMOKE=1 bunx vitest run tests/packaged/macos_bootstrap_smoke_test.ts
RUN_PACKAGED_PROCESSING=1 bunx vitest run tests/packaged/macos_processing_smoke_test.ts
RUN_PACKAGED_WORKSTATION=1 bunx vitest run tests/packaged/macos_local_workstation_dogfood_test.ts
RUN_PACKAGED_CAPTURE_SMOKE=1 bunx vitest run tests/packaged/macos_capture_recovery_smoke_test.ts
RUN_PACKAGED_NATIVE_SECURITY_SMOKE=1 bunx vitest run tests/packaged/macos_native_security_helper_smoke_test.ts
RUN_PACKAGED_LIVE_CAPTION=1 bunx vitest run tests/packaged/macos_live_caption_worker_smoke_test.ts
RUN_PACKAGED_CAPTION_FORMAL=1 bunx vitest run tests/packaged/macos_caption_formal_smoke_test.ts
RUN_PACKAGED_AI_BOUNDARY=1 bunx vitest run tests/packaged/macos_ai_boundary_smoke_test.ts
RUN_PACKAGED_COMPANION_SMOKE=1 bunx vitest run tests/packaged/macos_companion_smoke_test.ts

cd "${repository_root}"
./tool/dev_check.sh
python3 -m unittest tool/test_validate_electron_desktop_scope.py
python3 tool/validate_electron_desktop_scope.py
./tool/ensure_ui_watcher.sh
