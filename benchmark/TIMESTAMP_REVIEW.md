# Timestamp Boundary Independent Review

Scope decision `S2-MOBILE-CORE-2026-07-25` keeps
`ASR-005-TIMESTAMP-INDEPENDENT` mandatory for S2 Mobile Core. This worksheet is
the remaining Core evidence path; automatic confidence, hotwords and other
deferred capabilities cannot substitute for it.

This review approves reference speech boundaries only. It does not approve model
predictions or the release gate by itself.

## Prepare the blind-listening packet

```bash
python3 benchmark/prepare_timestamp_review.py
```

The command writes two cropped WAV clips, their hashes, and
`annotations.template.json` under
`build/asr_benchmark/timestamp_review/`. The worksheet intentionally omits the
current provisional boundary values so they cannot anchor the reviewer.

## Reviewer procedure

1. The reviewer must be independent of the energy-assisted annotation and model
   prediction generation.
2. Listen to each cropped WAV in an editor that displays milliseconds. Do not
   inspect `benchmark/audio/timestamp_manifest.json` first.
3. Add one `segments` entry per audible speech segment using the shape
   `{"sequenceId": 0, "startMs": 125, "endMs": 940}`. Start `sequenceId` at
   zero and keep it contiguous. Times are relative to the cropped clip, not the
   original five-minute fixture.
4. Fill `reviewer` and `reviewedAt`, then set the worksheet `reviewStatus` to
   `approved` only after both clips are complete. Preserve
   `review_packet.json` with the completed worksheet as review evidence.

Every boundary must be an integer number of milliseconds, ordered by
`sequenceId`, with `0 <= startMs < endMs <= clip duration`. Adjacent segments
must not overlap.

## Apply and evaluate

After review, copy the approved boundaries into
`benchmark/audio/timestamp_manifest.json`. Set each case's `reviewStatus` to
`approved`, change `annotationMethod` to `independent listening review`, and
record a reviewer name or initials in `reviewedBy` and an ISO 8601 timestamp in
`reviewedAt`. The evaluator rejects an approved case when either field is
missing. A second person should verify that the manifest exactly matches the
completed worksheet.

Run the production model on a physical Android device and convert its real
segment output to the prediction shape documented in `benchmark/README.md`.
Never use `timestamp_evaluator_selftest_predictions.json` as product evidence.
Then run:

```bash
python3 benchmark/evaluate_transcript_timestamps.py \
  --predictions build/asr_benchmark/timestamps/predictions.json \
  --report build/asr_benchmark/timestamps/report.json
```

The timestamp gate closes only when the report has `passed: true`,
`releaseEligible: true`, and `p95ErrorMs <= 1500`.

## Current physical prediction status (2026-07-25)

The previous one-segment result was investigated before changing the
production contract:

- four Silero threshold/min-silence profiles all returned one region per clip;
- the installed Paraformer returned 69/201 tokens but zero token timestamps,
  so token-gap splitting was unavailable;
- Silero is now retained as the outer speech detector while an adaptive
  per-region RMS stage splits only sustained low-energy gaps. The algorithm
  uses no hard-coded fixture timestamps.

The updated production `RealSherpaTranscriptionEngine` ran both fixed clips on
the physical Xiaomi M2102J2SC and returned five Chinese and four English
segments. Prediction SHA-256:
`01b77e52dd6eadd048a6a2cd91952e7502ad9f6e856010b08d32923a4be1c0d7`.

Against the unchanged provisional boundaries, the tooling-only report passed
with P95 182 ms across 18 boundaries. Report SHA-256:
`d94940888f4786e212c3b468a633af84241ad27bee34b3bda22b91e3109d9459`.
The report explicitly has `releaseEligible: false`.

The production segmentation mismatch is resolved. ASR-005 remains BLOCKED
solely on the independent blind-listening review and the subsequent normal
physical-device evaluation. The implementing agent cannot act as the
independent reviewer, and the manifest must remain provisional until that
review is completed.
