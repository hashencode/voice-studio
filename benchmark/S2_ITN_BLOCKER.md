# S2 ITN Gate

Date: 2026-07-25

## Scope disposition

Decision `S2-MOBILE-CORE-2026-07-25` marks advanced ITN as
`DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED`. Real punctuation and deterministic
segmentation remain in S2 Mobile Core; this ITN blocker and its fail-closed
asset gate remain unchanged for the future PC text-quality phase.

## Result

ASR-004 inverse text normalization remains closed with reason `itn_asset_missing`.

The installed sherpa-onnx AAR exposes `ruleFsts` and `ruleFars`, but the app package and repository contain no redistribution-approved FST/FAR asset for Chinese numbers, dates, time, RMB amounts, or units. The project therefore does not package an ITN asset, add one to `pubspec.yaml`, or enable ITN in the production model descriptor.

## Implemented preparation

- `CompleteMatchItnBackend` defines an exact-complete-input contract. An uncovered input returns `null` and remains unchanged.
- `TextNormalizationPostProcessor` checks deterministic repeat output, rejects blank output, and copies only segment text.
- `itn_golden.json` covers number, date, 24/12-hour time, RMB amount, and unit expectations plus ambiguous, mixed-language, serial-number, phone-number, and partial-match preservation.
- `benchmark/itn_asset_manifest.json` pins the golden fixture and states the
  disabled product gate. `validate_itn_assets.py` rejects an enabled gate
  unless the asset path, bytes, SHA-256, SPDX license/evidence, and
  complete-match deterministic backend are all present.
- The production engine reads the verified capability gate. With the current closed gate it does not invoke ITN. If a descriptor is incorrectly marked verified without a configured processor, the job fails at the structured `itn` stage with `ITN_FAILED`.
- Punctuation runs before the guarded ITN stage. Repeated ITN processing is required to be idempotent.

The golden outputs define the acceptance contract for a future licensed backend. Passing them with the in-test exact-match backend proves the integration boundary and invariants; it does not prove or license a production ITN asset.

## Reproduce

```bash
python3 benchmark/validate_itn_assets.py
python3 benchmark/validate_itn_assets.py --require-enabled  # expected BLOCKED

cd apps/mobile-flutter/android
./gradlew :app:testDebugUnitTest \
  --tests 'com.voice2text.app.transcription.TextNormalizationPostProcessorTest' \
  --tests 'com.voice2text.app.transcription.TranscriptionExecutorTest'
```

## Conditions to open the gate

1. Record the exact upstream artifact, version, SHA-256, model/rule family, license, and redistribution terms.
2. Package the asset under `apps/mobile-flutter/assets/sherpa/itn/` and add only those verified files to `apps/mobile-flutter/pubspec.yaml`.
3. Implement the production `CompleteMatchItnBackend` or AAR FST/FAR configuration without substring guessing.
4. Pass the committed golden fixture, ambiguity preservation, idempotence, punctuation ordering, segment invariants, error-stage, long-transcript performance, and physical-device production-path checks.
5. Only then change both Android and Dart ITN gates to `available=true`, `verified=true`.
