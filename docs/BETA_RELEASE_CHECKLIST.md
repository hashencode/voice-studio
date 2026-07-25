# Beta Release Checklist (Android)

1. Run fast checks:
```bash
./tool/dev_check.sh
```

For a build artifact:

```bash
./tool/dev_check.sh --with-build
```

2. Configure signing and app id:
```bash
./tool/fix_key_properties.sh
./tool/set_signing_passwords.sh
```

3. Verify release preflight:
```bash
./tool/preflight_release.sh
```
Requirement: `Preflight result: PASS` with **0 errors**.

4. Build release APK:
```bash
flutter build apk --release
```

5. Smoke test on device/emulator:

```bash
./tool/run_android_smoke.sh
./tool/check_transcribe_log.sh
./tool/run_meeting_flow_smoke.sh <android-device-id>
```

- Open app and accept the versioned recording consent.
- Record, stop, and verify the persistent queue completes.
- Import a supported media file and verify dedupe.
- Open the meeting workspace; play, seek a segment, edit/undo, search, and export.
- Verify the receiving app reads the shared file.
- Retry a deliberately interrupted deletion and confirm no managed file or dependent row remains.
- Verify the AI section says no production provider is configured; fixture evidence may be reviewed only in tests.

6. Complete release evidence:

- [x] Two-hour lock-screen/background recording retained successfully. Xiaomi M2102J2SC session `7edb7c06-5aa9-42ad-9a35-b61e39e9d5e9` finalized at 7,266,560 ms; the 58,590,545-byte canonical M4A remains on-device, has a byte-identical local copy with SHA-256 `98b86cbc60791c5bd6ab1000c18b47abbdd77f63169841f5cdb70d19683f0d24`, and played successfully in the app.
- [x] Ten sequential recording sessions passed on Xiaomi M2102J2SC (10 unique sessions, nonempty files, database rows, and terminal jobs).
- [x] Mid-tier Xiaomi 10S completed the 7,266.56 s transcription in
  174,355 ms (RTF≈0.024), with sampled peak total RSS `655,024 KB` versus
  restarted no-task baseline `599,648 KB` (difference `55,376 KB`), within
  the RTF≤1.0 and incremental RSS≤512 MB gate.
- [x] Low-tier EVA-AL10 completed the 7,266.56 s run without OOM, LMK,
  process restart, retry, duplicate job, or thermal abort. The job completed
  once in 434,035 ms (RTF=0.060); sampled peak RSS/PSS were
  787,200/737,648 KB and temperature remained 38.0-39.0°C. Evidence:
  `build/device-evidence/2026-07-24-low-eva-al10-2h/summary.md`.
- [ ] Timestamp annotations are independently approved and P95 boundary error ≤1.5 seconds.
- [x] Mid-tier Xiaomi M2102J2SC and low-tier EVA-AL10 system-picker import, SHA-256 dedupe, completed queue job, and OEM system-share receiver byte-for-byte read passed on 2026-07-24.
- [x] Mid-tier Xiaomi M2102J2SC and low-tier EVA-AL10 queue restart/re-attachment passed without duplicate jobs on 2026-07-24.
- [x] Low-tier EVA-AL10 M2 and M6-M10 physical scenarios passed: lock-screen/background notification stop; import/dedupe/share; force-stop queue recovery; real-audio playback, edit/search/undo and four-format export; deletion failure retention and zero-residue retry. Evidence: `build/device-evidence/2026-07-24-low-eva-al10-scenarios/summary.md`.
- [x] `docs/REAL_DEVICE_REGRESSION_MATRIX.md` has no required `PENDING` entries.
- [x] Production-source log/network scan contains no transcript body, meeting title, credential, endpoint, implicit upload path, or sensitive full path (2026-07-24).

7. Archive artifact:
- `build/app/outputs/flutter-apk/app-release.apk`

8. Tag release notes:
- version from `pubspec.yaml`
- known limitations (if any)

Do not release while the timestamp report says `releaseEligible=false`. The
`S2-MOBILE-CORE-2026-07-25` device matrix is BLOCKED on
`ASR-005-TIMESTAMP-INDEPENDENT`; S1 high-end coverage, EXP-005, formal signing
and release delivery also remain separate prerequisites. Deferred advanced
capabilities are not PASS and do not waive these release conditions.
