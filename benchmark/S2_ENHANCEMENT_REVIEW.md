# S2 Speech Enhancement Review

Date: 2026-07-25

## Scope disposition

Decision `S2-MOBILE-CORE-2026-07-25` marks GTCRN/AEC
`DEFERRED_TO_ADVANCED` / `DEFERRED_NOT_PASSED`. It no longer blocks S2 Mobile
Core, but every failed metric below remains a future production-admission gate.
GTCRN remains noise suppression and does not provide AEC.

## Result

The GTCRN asset is technically available and licensed, and the complete
preregistered five-case Xiaomi mid-device run was collected. The candidate
failed the quiet-speech, mean noisy-CER improvement, enhancement RTF, native
memory, and paired-boundary gates. The product gate therefore remains
unverified with reason `enhancement_preregistered_gates_failed`.
`denoiseReady` stays false, the request default stays false, and the production
engine does not invoke enhancement.

This work does not claim acoustic echo cancellation. GTCRN is evaluated only as offline noise suppression.

## Asset provenance

- Packaged file: `apps/mobile-flutter/assets/sherpa/onnx/speech-enhancement.onnx`
- Upstream name: `gtcrn_simple.onnx`
- Upstream release: `https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx`
- Size: 535,638 bytes
- SHA-256: `e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534`
- Verification: the packaged file is byte-identical to the official Sherpa release asset.
- Model family: GTCRN, from the official `Xiaobin-Rong/gtcrn` project.
- Model license: MIT; the packaged notice is `apps/mobile-flutter/assets/sherpa/onnx/GTCRN_LICENSE.txt`.
- Runtime: sherpa-onnx Android AAR v1.13.3, Apache-2.0.

## Implemented experiment boundary

- `SpeechEnhancementProcessor` wraps the installed offline GTCRN API, copies input before inference, supports cancellation before and after inference, rejects empty/non-finite/wrong-rate output, and releases native state exactly once.
- `ModelAssetManager` extracts the candidate atomically through a partial file.
- No production request path calls the processor while the capability gate is unverified.
- `benchmark/audio/s2_noise_manifest.json` preregisters the quiet, steady-noise, burst-noise, near-talk, and far-talk cases and all accuracy, timestamp, RTF, memory, thermal, and device-class gates.
- `benchmark/prepare_s2_noise_audio.py` generated all five full-length WAVs twice with identical hashes. Generated audio remains under `build/asr_benchmark/`.

## Physical API/ABI smoke

The connected Xiaomi M2102J2SC (Android 13, existing mid-class reference) passed `SpeechEnhancementModelSmokeTest`:

- input: 80,000 deterministic noisy samples at 16 kHz (5 seconds)
- output: 79,872 finite samples at 16 kHz
- inference: 389 ms, RTF 0.0778
- model bytes: 535,638
- input SHA-256: `2bbeb5747a59b7563a2d0d3ea0067f6dfbd0b5cc81cfd00102d34e6bf420d7b8`
- output SHA-256: `d11be47e98eb2352e6e880f290b5cfd9caf7a5d67af6a91216a06a05b9dae2fd`
- measured heap: 23,992,600 Java bytes and 17,506,536 native bytes

This proves the installed API, ABI, model extraction, model family, and basic
device inference. The full paired run below supersedes the earlier “benchmark
pending” state; it does not turn the candidate into a product capability.

## Complete paired Xiaomi gate

`SpeechEnhancementPairedGateTest` ran the raw production Paraformer/VAD path and
the GTCRN-enhanced production Paraformer/VAD path for all five deterministic
300.655-second cases. The instrumentation completed 5/5 in 1,460.281 seconds.
Transcription text remains only in the ignored `build/` report.

- Raw device report SHA-256:
  `05749363f647b30cf337bf61c0a843cd288937aa7f3ff416835120b231f23362`
- Physical model-identity report SHA-256:
  `2fec9d260f8bedf82edb32b9933442a6a0073e61922eb6823e89d48a197e5bb3`;
  it binds the paired report to the pinned Paraformer model/tokens and GTCRN
  hashes.
- Evaluator report SHA-256:
  `b7ae589b0c8494a06c1b5952c462a2a20319a83859d845da9b42474dffa3a14a`

| Gate | Observed | Threshold | Result |
| --- | ---: | ---: | --- |
| quiet CER absolute regression | +0.008876 | ≤0.005 | **FAIL** |
| mean noisy-case CER absolute improvement | +0.002301 | ≥0.05 | **FAIL** |
| worst noisy-case CER regression | +0.017751 | ≤0.02 | PASS |
| maximum enhancement-only RTF | 0.327299 | ≤0.25 | **FAIL** |
| maximum combined enhanced pipeline RTF | 0.501469 | ≤1.0 | PASS |
| maximum Java heap delta | 62,823,400 bytes | ≤67,108,864 | PASS |
| maximum native heap delta | 349,676,096 bytes | ≤134,217,728 | **FAIL** |
| paired-boundary P95 delta | 616 ms, only 3/5 cases comparable | ≤250 ms and 5/5 comparable | **FAIL** |
| thermal status | 0 before / 0 after | no severe throttling | PASS |
| source preservation | all five inputs unchanged | required | PASS |

The quiet raw/enhanced CER was 3.5503%/4.4379%. The noisy cases were
steady-noise, burst-noise, and far-talk; their mean raw/enhanced CER was
13.1821%/12.9520%. Battery was observational only: Android reported 100% before
and after, with charge-counter 3,150,995→3,150,993 µAh. This is not a
calibrated energy-consumption PASS.

The paired-boundary comparison is not an absolute timestamp-accuracy result.
Two cases had different raw/enhanced segment counts, and the remaining three
only measure raw-vs-enhanced drift. Independent reference boundaries are still
required for release evidence.

## Remaining promotion evidence and decision

The current candidate already fails mandatory mid-device thresholds, so it
must not be promoted even if the external evidence below is later supplied.
Any revised candidate or processor must rerun the same fixed set and pass:

- quiet CER regression is no more than 0.5 percentage points;
- mean noisy-case CER improves by at least 5 percentage points and no noisy case regresses by more than 2 points;
- timestamp P95 and delta, enhancement/combined RTF, heap deltas, thermal behavior, and source preservation meet the manifest thresholds;
- both low- and mid-class physical devices pass.

The low-class EVA-AL10 run and independently reviewed absolute timestamps remain
missing. No AEC implementation or evidence exists. These missing items are
additional blockers; they do not erase the measured Xiaomi failures.

## Primary sources

- [Sherpa speech enhancement API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/speech_enhancement.html)
- [Sherpa speech-enhancement model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models)
- [Official GTCRN implementation](https://github.com/Xiaobin-Rong/gtcrn)
