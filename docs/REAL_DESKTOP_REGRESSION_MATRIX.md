# Real desktop regression matrix

Decision: `DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26`

This matrix records target-specific physical macOS evidence. It does not transfer
PASS to Windows or Android. macOS is `PASS` with disposition
`MACOS_CLOSED_FOR_WINDOWS_ENTRY`; Windows is `PLANNED` and must rerun the frozen
finalists and product flow on its own reference target.

## Reference target

| Field | Value |
| --- | --- |
| OS | macOS 15.7.5 |
| Architecture | arm64 |
| CPU | Apple M2, 8 logical CPUs |
| Memory | 16 GiB (`17179869184` bytes) |
| Product runtime | `sherpa-onnx-c-api@1.13.4` |
| ASR | `sherpa-streaming-zipformer-zh-14m-2023-02-23` |
| Diarization | `sherpa-pyannote-3.0-3dspeaker`, threshold `0.65` |
| Worker boundary | native process group; 2 threads per worker |

## Product regression

| Unit | Scenario | Physical result | Evidence |
| --- | --- | --- | --- |
| U4 | Debug app build, system file import, private-copy hash, persistent pending job, missing-model truth | PASS | `desktop-workstation-u4-evidence.json`, SHA-256 `1e500e4e5251c3facd8399f048a117a80d08fd19e6b955c22cb7565e4a6277bf` |
| U5 | Fixed Chinese ASR, five-minute diarization, 120-minute resource run, cancellable native boundary | PASS | `desktop-workstation-u5-evidence.json`, SHA-256 `272416a6fe4cdf027087d2ade10fef16ef95dfb76642e5759c1d8a2c0f88fef4` |
| U6 | Sherpa/FunASR and Sherpa/pyannote comparison; finalist and license freeze | PASS | `desktop-workstation-u6-evidence.json`, SHA-256 `1a958db003898151fcb7f64ff9af3e00cd553e4f66cd83f34294cb43a4aec697` |
| U7 | Signed app, model activation, local ASR+speaker flow, recovery, editing, AI consent, five exports | PASS | `desktop-workstation-u7-evidence.json`, SHA-256 `61a148984a10aba41d81b8aa0f46080e96f174c870ad88245428f0af6983753a` |
| U8 | Xiaomi M2102J2SC → Apple M2 encrypted/resumable LAN transfer, receipt and replay behavior | PASS | `desktop-workstation-u8-evidence.json`, SHA-256 `45fa4224398d66d0cc81d8e81293e7940b2e27aaa9eb6f893cb40320bcb4b4f5` |
| U9 | Final 120-minute processing, five-meeting dogfood, interaction, lifecycle, security and accessibility closure | PASS | `desktop-workstation-u9-evidence.json`, SHA-256 `c7d0477ddbb787abb4bcc54cd692ffcd9c279b371698d0cd41ed261381699439` |

## U9 closure measurements

| Gate | Threshold | Result |
| --- | --- | --- |
| 120-minute full ASR + diarization | `< 30 min` | `1787419 ms` (`29:47.419`), RTF `0.248253`, 22,141 segments |
| Dogfood speaker corrections | `<= 10%` across five meetings | `73/913`, `7.996%` |
| 3,001-segment workspace open P95 | `<= 2 s` | `7.323 ms` |
| Search P95 | `<= 200 ms` | `0.641 ms` |
| Real playback seek P95 | `<= 200 ms` | `0.326 ms` |
| Fixed-scroll long-frame rate | `< 1%` | `1/484`, `0.207%` |
| Peak RSS during final long run | recorded, target-specific | `1165901824` bytes across the two workers |

The long run used two concurrent 2-thread shards with a 120-second overlap.
Anonymous speaker labels were aligned in the overlap, and the result was cut at
the 3,600-second midpoint so no duplicate turns were published. Cancellation and
publication still belong to one logical processing job.

## Lifecycle, security, and accessibility

- Import staging, sidecar workspaces, and ephemeral share files are removed after
  24 hours. Interrupted LAN checkpoints expire after 7 days.
- A successful receipt deletes transfer chunks and payload immediately. Unpair
  removes credentials, checkpoints, and receipt metadata while retaining the
  committed meeting. Cleanup does not follow symlinks.
- FileVault was **off** during capture. The app truthfully says that meeting
  database and audio files have no app-layer whole-store encryption and prompts
  the user to enable FileVault. API and pairing secrets remain in macOS Keychain.
- Keyboard navigation, semantic navigation labels, dark mode, 200% text scale,
  virtualized long transcripts, and non-drag playback/seek actions passed the
  real macOS integration suite.
- The worker receives only a fixed locale environment, and packet inspection of
  the U8 LAN flow found no fixed plaintext meeting content or reusable credential.

## Reproduction and closure commands

```bash
cd apps/desktop
flutter test integration_test/macos_workstation_regression_test.dart -d macos
flutter test test/u9_long_meeting_gate_test.dart --plain-name \
  'U9 real 120-minute final product pipeline closes under 30 minutes'
flutter test test/u7_dogfood_gate_test.dart --plain-name \
  'five-meeting dogfood passes the frozen product threshold'
cd ../..
python3 tool/validate_macos_closure.py
./tool/dev_check.sh --with-build
```

The two long-running product gates are evidence-producing gates and are not
silently replaced by synthetic results in routine test runs. The closure
validator binds the recorded target, fixture, runtime artifacts, upstream unit
evidence, measurements, lifecycle/security assertions, and product disposition
to their SHA-256 values.
