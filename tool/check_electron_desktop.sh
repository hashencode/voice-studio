#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
electron_root="${repository_root}/apps/desktop-electron"
runner="${repository_root}/tool/run_electron_desktop_gate.py"
closure_deadline_ms="$(( $(date +%s) * 1000 + 1800000 ))"

run_stage() {
  local command_id="$1"
  shift
  python3 "${runner}" \
    --cwd "${repository_root}" \
    --deadline-epoch-ms "${closure_deadline_ms}" \
    --command-id "${command_id}" \
    -- "$@"
}

run_gate() {
  local command_id="$1"
  shift
  local -a binding_arguments=()
  while [[ "$1" != "--" ]]; do
    binding_arguments+=(--binding "$1")
    shift
  done
  shift
  python3 "${runner}" \
    --cwd "${electron_root}" \
    --deadline-epoch-ms "${closure_deadline_ms}" \
    --command-id "${command_id}" \
    --source-revision "${source_revision}" \
    --relevant-source-sha256 "${relevant_source_sha256}" \
    --target-sha256 "${target_sha256}" \
    --package-sha256 "${package_sha256}" \
    "${binding_arguments[@]}" \
    -- "$@"
}

run_stage cache-guard python3 tool/build_cache_guard.py --wait-for-idle
run_stage bun-install bun --cwd apps/desktop-electron ci
run_stage electron-check bun --cwd apps/desktop-electron run check
run_stage electron-package bun --cwd apps/desktop-electron run package
run_stage package-smoke bun --cwd apps/desktop-electron run smoke:package

source_revision="$(git -C "${repository_root}" rev-parse HEAD)"
relevant_source_sha256="$(cd "${repository_root}" && python3 -c 'from tool.validate_electron_desktop_scope import _relevant_source_sha256; print(_relevant_source_sha256(__import__("pathlib").Path.cwd(), "HEAD"))')"
target_sha256="$(cd "${repository_root}" && python3 -c 'from tool.validate_electron_desktop_scope import _current_target, _json_sha256; print(_json_sha256(_current_target()))')"
package_sha256="$(cd "${repository_root}" && python3 -c 'from tool.validate_electron_desktop_scope import _bundle_manifest_sha256; from pathlib import Path; print(_bundle_manifest_sha256(Path("apps/desktop-electron/out/Voice2Text-darwin-arm64/Voice2Text.app")))')"
receipt_root="docs/product/electron-closure-receipts"

run_gate packaged-bootstrap \
  "gate-lifecycle.application:apps/desktop-electron/tests/packaged/macos_bootstrap_smoke_test.ts:${receipt_root}/gate-lifecycle.application.json" \
  -- /usr/bin/env RUN_PACKAGED_SMOKE=1 bunx vitest run tests/packaged/macos_bootstrap_smoke_test.ts
run_gate packaged-processing \
  "gate-library.import:apps/desktop-electron/tests/packaged/macos_processing_smoke_test.ts:${receipt_root}/gate-library.import.json" \
  "gate-processing.tasks:apps/desktop-electron/tests/packaged/macos_processing_smoke_test.ts:${receipt_root}/gate-processing.tasks.json" \
  -- /usr/bin/env RUN_PACKAGED_PROCESSING=1 bunx vitest run tests/packaged/macos_processing_smoke_test.ts
run_gate packaged-workstation \
  "gate-shell.navigation:apps/desktop-electron/tests/packaged/macos_local_workstation_dogfood_test.ts:${receipt_root}/gate-shell.navigation.json" \
  "gate-library.meetings:apps/desktop-electron/tests/packaged/macos_local_workstation_dogfood_test.ts:${receipt_root}/gate-library.meetings.json" \
  "gate-meeting.review:apps/desktop-electron/tests/packaged/macos_local_workstation_dogfood_test.ts:${receipt_root}/gate-meeting.review.json" \
  "gate-accessibility.desktop:apps/desktop-electron/tests/packaged/macos_local_workstation_dogfood_test.ts:${receipt_root}/gate-accessibility.desktop.json" \
  -- /usr/bin/env RUN_PACKAGED_WORKSTATION=1 bunx vitest run tests/packaged/macos_local_workstation_dogfood_test.ts
run_gate packaged-capture \
  "gate-capture.workspace:apps/desktop-electron/tests/packaged/macos_capture_recovery_smoke_test.ts:${receipt_root}/gate-capture.workspace.json" \
  "gate-capture.recovery:apps/desktop-electron/tests/packaged/macos_capture_recovery_smoke_test.ts:${receipt_root}/gate-capture.recovery.json" \
  -- /usr/bin/env RUN_PACKAGED_CAPTURE_INITIALIZE_ONLY=0 RUN_PACKAGED_CAPTURE_SMOKE=1 bunx vitest run tests/packaged/macos_capture_recovery_smoke_test.ts
run_gate packaged-native-security \
  "gate-settings.security:apps/desktop-electron/tests/packaged/macos_native_security_helper_smoke_test.ts:${receipt_root}/gate-settings.security.json" \
  -- /usr/bin/env RUN_PACKAGED_NATIVE_SECURITY_SMOKE=1 bunx vitest run tests/packaged/macos_native_security_helper_smoke_test.ts
run_gate packaged-live-caption \
  "gate-settings.runtime:apps/desktop-electron/tests/packaged/macos_live_caption_worker_smoke_test.ts:${receipt_root}/gate-settings.runtime.json" \
  -- /usr/bin/env RUN_PACKAGED_LIVE_CAPTION=1 bunx vitest run tests/packaged/macos_live_caption_worker_smoke_test.ts
run_gate packaged-caption-formal \
  "gate-captions.live:apps/desktop-electron/tests/packaged/macos_caption_formal_smoke_test.ts:${receipt_root}/gate-captions.live.json" \
  -- /usr/bin/env RUN_PACKAGED_CAPTION_FORMAL=1 bunx vitest run tests/packaged/macos_caption_formal_smoke_test.ts
run_gate packaged-ai-boundary \
  "gate-settings.ai:apps/desktop-electron/tests/packaged/macos_ai_boundary_smoke_test.ts:${receipt_root}/gate-settings.ai.json" \
  -- /usr/bin/env RUN_PACKAGED_AI_BOUNDARY=1 bunx vitest run tests/packaged/macos_ai_boundary_smoke_test.ts
run_gate packaged-companion \
  "gate-companion.pairing:apps/desktop-electron/tests/packaged/macos_companion_smoke_test.ts:${receipt_root}/gate-companion.pairing.json" \
  "gate-companion.transfer:apps/desktop-electron/tests/packaged/macos_companion_smoke_test.ts:${receipt_root}/gate-companion.transfer.json" \
  -- /usr/bin/env RUN_PACKAGED_COMPANION_SMOKE=1 bunx vitest run tests/packaged/macos_companion_smoke_test.ts

run_stage root-dev-check ./tool/dev_check.sh
run_stage closure-validator-tests python3 -m unittest tool/test_validate_electron_desktop_scope.py tool/test_run_electron_desktop_gate.py
run_stage closure-validator python3 tool/validate_electron_desktop_scope.py
run_stage ui-watcher ./tool/ensure_ui_watcher.sh
