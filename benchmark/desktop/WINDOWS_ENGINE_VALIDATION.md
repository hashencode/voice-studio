# Windows finalist and product validation

Decision: `DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26`

Current state: `PENDING_WINDOWS_EXECUTION`

This document is the execution record for U10. It is intentionally not Windows
evidence and does not change Windows capability truth. macOS has disposition
`MACOS_CLOSED_FOR_WINDOWS_ENTRY`; Windows remains `PLANNED` until every required
target-specific gate below runs on the Windows reference target.

## Frozen scope

Windows may retest only the macOS finalists:

- ASR: `sherpa-streaming-zipformer-zh-14m-2023-02-23`
- Diarization: `sherpa-pyannote-3.0-3dspeaker`
- Runtime family: `sherpa-onnx-c-api@1.13.4`

Windows cannot inherit macOS PASS, reopen FunASR or pyannote Community-1, or
introduce a Windows-specific model in this plan. If the frozen finalists do not
pass the Windows functional and resource gates, the terminal result is
`WINDOWS_NO_ADMISSIBLE_FINALIST`.

## Execution-surface requirement

Generate `apps/desktop/windows/`, native dependencies, packaged worker/launcher,
and all files below `benchmark/desktop/evidence/windows/` on Windows only. Do not
generate the runner on macOS and do not treat cross-platform Dart analysis as a
Windows build.

The reference record must include:

- Windows edition, version and build;
- CPU model, architecture, logical processors and memory;
- Flutter/Dart, Visual Studio, CMake and Windows SDK versions;
- runtime/model/fixture and packaged artifact SHA-256 values;
- worker threads, clustering threshold and process-isolation boundary;
- quality, elapsed time, RTF, peak working set and cancellation result.

## Static portability inventory

The following bindings are known and must be replaced or supplied by the
Windows runner before a benchmark is admissible:

| Area | macOS binding | Required Windows proof |
| --- | --- | --- |
| Runner/import | Swift method channel for private copy | Win32 runner channel with descriptor validation, capacity preflight, streaming SHA-256, flush and atomic commit |
| Runtime layout | app `Contents/Frameworks` and `Resources/Processing` | Windows bundle-relative DLL, worker and launcher paths |
| Worker cancellation | POSIX process group plus `/bin/kill` | Windows Job Object or equivalent descendant-owning kill boundary; no orphan |
| Model install | `/bin/df`, `/usr/bin/tar` | Target-tested free-space probe and controlled archive extraction |
| Secrets | macOS Keychain options | `flutter_secure_storage` Windows DPAPI-backed storage, tested for replace/delete and no SQLite/config persistence |
| Disk protection | `fdesetup` / FileVault disclosure | Truthful Windows device-encryption/BitLocker status or explicit unknown; no claim of app-layer whole-store encryption |
| Discovery | macOS Network.framework/DNS-SD channel | Windows firewall/mDNS registration and understandable local-import fallback when denied |
| Capacity | POSIX `df` for model/transfer roots | Windows volume capacity for both model and incoming transfer roots |
| Sidecar | `sandbox-exec`, POSIX `ps` | Windows containment, memory/time/output limits and descendant termination |
| Native runtime | `.dylib` names and arm64 worker | x86_64 DLL names, dependency resolution and signed/hashed packaged executable |

The frozen manifest parser accepts only `macos/arm64` and `windows/x86_64`.
That schema support is not product admission: no Windows manifest is packaged
until the reference target produces the required hashes and licenses.

## Mandatory Windows scenarios

1. With no Windows target evidence or manifest, model install and processing
   capability remain blocked without a simulated transcript.
2. Generate the Windows runner with Flutter on the Windows target; resolve all
   plugins and build the Debug application.
3. Import local files through the system picker. Cover Unicode, spaces, long
   paths, duplicate hashes, unreadable/replaced files, restart, and capacity
   failure.
4. Run the fixed finalist ASR and diarization fixtures and the operational
   resource/cancellation gates. Record independent Windows measurements.
5. Complete the local meeting flow: persistent job, playback, virtualized
   transcript, search, edit/undo/redo, anonymous/overlap/unknown speaker
   correction, evidence-linked notes, and five exports.
6. Verify DPAPI-backed secrets, truthful disk-protection disclosure, sidecar
   lifecycle, app restart recovery, process cancellation and runtime
   install/repair/uninstall.
7. Exercise Windows Defender/firewall denial. LAN receive may degrade, but local
   import must remain fully usable and the explanation must be actionable.
8. On a real shared LAN, complete Android-to-Windows pairing, encrypted
   interrupted/resumed transfer, hash-verified import, idempotent receipt,
   replay rejection, default source retention and unpair cleanup.
9. Run keyboard, semantics, dark mode, 200% text, 3,000+ segment interaction,
   playback seek, long-meeting, privacy, analyze/test, Debug build and real
   integration gates on Windows.

## Terminal evidence

Create a target-specific evidence manifest only after execution. A PASS manifest
must bind the reference fingerprint, upstream macOS finalist identities (not
their PASS), Windows runtime/model/fixture/artifact hashes, all measurements,
LAN evidence, security/lifecycle/accessibility outcomes and repository
verification. Update the product scope and real desktop regression matrix only
after the Windows validator accepts that manifest.

If finalist admission fails, record the failed functional/resource gates and
terminal `WINDOWS_NO_ADMISSIBLE_FINALIST`; do not search for another model in
U10.
