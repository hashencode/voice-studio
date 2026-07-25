# ASR Benchmark

This folder contains the ASR benchmark lab. The shipped mobile production route is standard recording followed by Silero outer detection, adaptive sustained-silence splitting, and offline Paraformer recognition. Online transducer and Live VAD experiments are isolated research inputs: they are not defaults and are excluded from mobile release and product capability claims.

## Storage Policy

- Commit benchmark code, manifests, fixed audio fixtures, small reports, and docs.
- Do not commit downloaded model archives, extracted model files, raw run outputs, or generated matrices.
- Local cache root: `build/asr_benchmark/`.

## Layout

- `asr_benchmark_manifest.json`: model matrix, VAD defaults, and archive URLs.
- `asr_benchmark_profiles.json`: short smoke and realtime-candidate profiles.
- `audio/`: committed Chinese and English benchmark wav/text fixtures.
- `audio/timestamp_manifest.json`: fixed timestamp windows and boundary-review state.
- `audio/s2_noise_manifest.json`: preregistered quiet/noise/near/far GTCRN comparison set and promotion thresholds.
- `audio/online_transducer_candidate_manifest.json`: fixed online-transducer score and decoder-hotword A/B contract.
- `asr_model_candidates.json`: auditable runtime/model license, artifact, capability, device, and admission registry.
- `android/src/debug/kotlin/`: debug-only Android benchmark Activity and runner.
- `prepare_asr_benchmark_audio.sh`: copies committed audio fixtures to `build/asr_benchmark/audio`.
- `prepare_asr_validation_audio.py`: prepares generated validation and length-validation manifests under `build/asr_benchmark/`.
- `download_asr_benchmark_models.sh`: downloads and extracts selected models into `build/asr_benchmark/models`.
- `run_asr_benchmark.sh`: builds the debug APK, installs assets, runs the benchmark Activity, and pulls JSON results.
- `generate_asr_profile_matrix.py`: generates repeatable VAD tuning matrices.
- `select_asr_benchmark_profiles.py`: selects top emulator profiles for focused or physical-device reruns.
- `generate_asr_benchmark_visual_report.py`: regenerates summary JSON and the single-route HTML report.
- `prepare_timestamp_review.py`: crops the fixed windows and generates a blind independent-review worksheet without exposing provisional boundaries.
- `prepare_s2_noise_audio.py`: deterministically generates the S2 speech-enhancement comparison WAVs under `build/asr_benchmark/`.
- `prepare_asr_candidate.py`: downloads and safely extracts only pinned files for a registered screening candidate.
- `evaluate_transcript_timestamps.py`: compares ordered production segment boundaries with independently reviewed references and enforces the 1.5-second P95 gate.
- `evaluate_online_transducer_candidate.py`: evaluates physical score/timestamp parity, CER, and fixed hotword A/B evidence without promoting raw scores to confidence.
- `evaluate_s2_enhancement.py`: evaluates preregistered raw/enhanced CER, timestamp delta, RTF, memory, thermal, and source-preservation evidence.
- `validate_itn_assets.py`: proves that ITN is either fully licensed/evidenced or explicitly fail-closed.
- `S2_ASR_CAPABILITY_REVIEW.md`: records the installed AAR, production model, bundled assets, license evidence, and current gate result for ITN, confidence, hotwords, and enhancement.
- `S2_ITN_BLOCKER.md`: records the deterministic ITN integration contract, golden fixture, and the missing licensed FST/FAR blocker.
- `S2_CONFIDENCE_REVIEW.md`: records the nullable production contract and the runtime-plus-model dependency for calibrated confidence.
- `S2_HOTWORD_BLOCKER.md`: records the Paraformer decoder incompatibility and paired candidate benchmark gate.
- `S2_ENHANCEMENT_REVIEW.md`: records official GTCRN provenance, the physical API/ABI smoke, the complete paired Xiaomi result, and the still-closed promotion gate.
- `asr_benchmark_test_plan.md`: regular three-part benchmark standard plus optional deep-search definitions.

## Quick Start

```bash
MODEL_IDS="paraformer-zh-2025-10-07 paraformer-en-2024-03-09" \
  PROFILE_IDS="standard_vad_silero_warm_t2" \
  ./benchmark/run_asr_benchmark.sh

./benchmark/generate_asr_benchmark_visual_report.py
open benchmark/asr_benchmark_visual_report_2026-07-05.html
```

## Timestamp Boundary Gate

Production timestamp predictions use this compact JSON shape:

```json
{
  "schemaVersion": 2,
  "source": "physical_android_production_engine",
  "cases": [
    {
      "id": "zh_timestamp_window_000",
      "audioSha256": "<cropped-review-clip-sha256>",
      "segments": [
        {"sequenceId": 0, "startMs": 560, "endMs": 3020}
      ]
    }
  ]
}
```

Run the gate with:

```bash
python3 benchmark/evaluate_transcript_timestamps.py \
  --predictions build/asr_benchmark/timestamps/predictions.json \
  --report build/asr_benchmark/timestamps/report.json
```

The committed boundaries are currently marked `provisional` because they were energy-assisted and still require independent listening review. The command therefore blocks release evidence by default. Approved cases must also carry non-empty `reviewedBy` and `reviewedAt` metadata. `--allow-provisional` exists only to exercise the evaluator while annotations are under review; its output sets `releaseEligible` to `false` and must not be cited as the S2 accuracy gate. `audio/timestamp_evaluator_selftest_predictions.json` copies those provisional boundaries only to exercise evaluator parsing and percentile behavior in `dev_check`; it is not model output and can never make the release gate eligible.

The manifest separately pins the five-minute source WAV hash and the cropped
review-clip hash. Physical predictions must report the latter; the evaluator
rejects substituting the source hash or an unpinned clip.

Prepare the blind-listening clips and empty annotation worksheet with:

```bash
python3 benchmark/prepare_timestamp_review.py
```

Follow [`TIMESTAMP_REVIEW.md`](TIMESTAMP_REVIEW.md) to complete the independent review, transfer approved boundaries, capture real physical-device predictions, and run the release-eligible evaluation.

`run_asr_benchmark.sh` automatically uses the only online Android device from `adb devices`. If more than one Android device is online, pass a serial with `DEVICE_ID=<serial>` or as the first script argument.

## Models

```bash
./benchmark/download_asr_benchmark_models.sh \
  paraformer-zh-2025-10-07 \
  paraformer-en-2024-03-09
```

Current pretrained model IDs:

| ID | Pretrained model |
| --- | --- |
| `paraformer-zh-2025-10-07` | `sherpa-onnx-paraformer-zh-int8-2025-10-07` |
| `paraformer-en-2024-03-09` | `sherpa-onnx-paraformer-en-2024-03-09` |

Prepare the isolated online transducer candidate with:

```bash
python3 benchmark/validate_asr_model_candidates.py
python3 benchmark/prepare_asr_candidate.py \
  streaming-zipformer-zh-14m-2023-02-23
```

The candidate is `lab_only`. Running its Android instrumentation and evaluator
does not add it to `TranscriptionModelRegistry` or make confidence/hotwords
available in the product.

## Speech-Enhancement Gate

Run the complete fixed five-case GTCRN gate on a physical Android device with:

```bash
./benchmark/run_s2_enhancement_gate.sh <physical-device-id>
```

The script verifies/downloads the pinned production benchmark model, generates
the deterministic 300.655-second quiet/noise/near/far fixtures, stages them in
app-private storage without clearing existing data, runs the raw/enhanced
production Paraformer/VAD pairs, and evaluates the pulled report. Raw
transcription text and generated WAVs remain under ignored
`build/asr_benchmark/`.

Instrumentation success means the complete evidence was collected; it does not
mean the promotion gates passed. Read `productGatePassed`,
`midDeviceTechnicalGatesPassed`, each entry under `gates`, and
`releaseBlockers` in the evaluator report. GTCRN is noise suppression, not AEC,
and production remains disabled until every preregistered low-/mid-device gate
has real PASS evidence.

## Parameter Profiles

Tracked profiles:

| Profile | Route | Parameters |
| --- | --- | --- |
| `standard_vad_silero_warm_t2` | standard VAD | Formal profile. Threshold `0.15`, minSilence `0.20s`, minSpeech `0.25s`, maxSpeech `5.0s`, recognizer threads `4`. |
| `live_vad_silero_paced_t2_f100` | live VAD paced replay | Isolated future-PC research profile; never selected by the standard mobile command. |
| `live_vad_silero_replay_t2_f100` | live VAD fast replay | Isolated historical diagnostic profile; never selected by the standard mobile command. |

Generate repeatable matrices:

```bash
./benchmark/generate_asr_profile_matrix.py \
  --preset focused \
  --output build/asr_benchmark/profile_matrices/paraformer-focused-grid.json \
  --batch-size 20

./benchmark/generate_asr_profile_matrix.py \
  --preset full \
  --output build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --batch-size 20
```

Regular test standard:

| Part | Profiles | Audio set | Test cases | Use |
| --- | ---: | --- | ---: | --- |
| Smoke | 1 | Core `zh` + `en` | 2 | Verify runner, assets, model loading, and standard VAD. |
| Focused | 96 | Validation manifest, 5 cases | 480 | Main standard VAD micro-sweep: `threshold=[0.15,0.20,0.25]`, `minSilence=[0.20,0.25,0.30,0.35]`, `maxSpeech=[4,5,6,8]`, `threads=[2,4]`. |
| Length / release validation | 1 | Length manifest, 12 cases | 12 | Validate selected standard VAD behavior across complete-audio lengths. |
| Total | - | - | 494 | Normal mobile benchmark standard. |

The 494-case standard is the mobile convergence and release-validation target. For active tuning, use the fast exploration path first so device time is spent on candidates instead of broad retesting.

Optional search layers:

| Preset | Profiles | Default zh+en rows | Use |
| --- | ---: | ---: | --- |
| `screening` | 10 | 20 | One-factor VAD sanity sweep around the default. Run one Chinese and one English audio case first during exploration. |
| `coarse` | 160 | 320 | Wider VAD sweep after focused results show a promising direction. |
| `full` | 630 | 1260 | Backup deep-search layer. Do not run as the normal full suite. |

## Fast Exploration Workflow

Use this workflow when tuning the standard offline VAD route. It separates Chinese and English early and runs one representative audio case per language before the 5-case validation set.

1. Run smoke with `standard_vad_silero_warm_t2` to verify the benchmark path.
2. Generate a `screening` matrix and run one Chinese audio case, then one English audio case.
3. If screening shows a non-default direction, generate a `focused` matrix and run one Chinese audio case plus one English audio case.
4. Select at most 3 standard VAD candidates per language/model: lowest error rate, fastest tied-accuracy profile, and most stable segmentation.
5. Validate selected standard VAD candidates on the 5-case validation manifest.
6. Run length / release validation for the final standard VAD candidate.
7. Rerun selected finalists on a physical device before changing production defaults.

Example single-audio screening:

```bash
./benchmark/generate_asr_profile_matrix.py \
  --preset screening \
  --output build/asr_benchmark/profile_matrices/paraformer-screening-grid.json

BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/profile_matrices/paraformer-screening-grid.json" \
  MODEL_IDS="paraformer-zh-2025-10-07" \
  AUDIO_CASES="zh" \
  DEVICE_ID="<physical-device-serial>" \
  ./benchmark/run_asr_benchmark.sh

BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/profile_matrices/paraformer-screening-grid.json" \
  MODEL_IDS="paraformer-en-2024-03-09" \
  AUDIO_CASES="en" \
  DEVICE_ID="<physical-device-serial>" \
  ./benchmark/run_asr_benchmark.sh
```

When running generated validation audio, also pass:

```bash
BENCHMARK_MANIFEST_FILE="$PWD/build/asr_benchmark/diagnostics/asr-validation-manifest.json" \
BENCHMARK_AUDIO_ROOT="$PWD/build/asr_benchmark/validation_audio"
```

Useful single-audio validation IDs are `zh`, `zh_validation_aishell_raw1`, `en`, `en_official_0`, and `en_official_1`.

## Standard Workflow

Use this workflow after fast exploration has identified candidates, or when running the formal benchmark standard without active tuning.

1. Run smoke with `standard_vad_silero_warm_t2` to verify the benchmark path.
2. Prepare validation audio with `./benchmark/prepare_asr_validation_audio.py --mode all`.
3. Run the `focused` standard VAD micro-sweep on the 5-case validation manifest.
4. Select candidates with `select_asr_benchmark_profiles.py`.
5. If a selected candidate clearly improves accuracy or keeps accuracy tied while improving RTF, run another neighbor-focused sweep from `paraformer-full-grid.json`.
6. Run length / release validation for the selected standard VAD profile.
7. Rerun selected finalists on a physical device before changing production defaults.
8. Use `coarse` or `full` only as optional deep-search layers when the focused results are inconclusive or a model/VAD/device change resets the search space.

Create a physical rerun profile file:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-file build/asr_benchmark/results/<emulator-run>.json \
  --output build/asr_benchmark/diagnostics/paraformer-physical-rerun.json
```

Run it on a physical device:

```bash
BENCHMARK_PROFILES_FILE="$PWD/build/asr_benchmark/diagnostics/paraformer-physical-rerun.json" \
  DEVICE_ID="<physical-device-serial>" \
  ASR_BENCHMARK_TIMEOUT_SECONDS=10800 \
  ./benchmark/run_asr_benchmark.sh
```

For a focused emulator follow-up:

```bash
./benchmark/select_asr_benchmark_profiles.py \
  --result-list-tsv build/asr_benchmark/logs/<run-id>-results.tsv \
  --neighbor-source build/asr_benchmark/profile_matrices/paraformer-full-grid.json \
  --neighbors-per-profile 2 \
  --improvement-baseline-profile-id "<prior-winning-profile-id>" \
  --output build/asr_benchmark/diagnostics/paraformer-focused-neighbors.json
```

## Live VAD Experiment Boundary

`live_vad` is not a mobile product candidate. The profiles remain in the debug-only benchmark source as historical evidence and possible input to a separately planned PC implementation. They are never selected by default and are excluded from mobile smoke, length/release validation, settings, runtime routing, and capability claims.

The benchmark `standard` and `live_vad` routes share the same Silero VAD model, VAD parameters, and Paraformer recognizer. With the default `liveFrameMs=100`, `live_vad` uses the same effective input cadence as the standard route's 100 ms VAD chunking. Run broad VAD parameter search on the standard route first, then retest only selected candidates with `live_vad_paced`.

Isolated live VAD profiles:

- `live_vad_silero_paced_t2_f100` feeds frames while sleeping to match the audio timeline.
- `live_vad_silero_replay_t2_f100` feeds wav samples as 100ms PCM frames as fast as the device can process them.

Running either profile requires explicit `PROFILE_IDS`; results cannot promote a mobile route. Any PC product decision belongs to its own plan and validation matrix.

## Retired RMS Experiment

Realtime RMS is no longer production code and is no longer a benchmark route. The last useful experimental parameter record is kept only for reference:

| Field | Value |
| --- | --- |
| profile id | `realtime_rms_t4_f080_thr0420_min0320_end1000_max16000_pre0000` |
| frame | `80ms` |
| speech threshold | `420` |
| min speech | `320ms` |
| end silence | `1000ms` |
| max segment | `16000ms` |
| pre-roll | `0ms` |
| recognizer threads | `4` |

Use this only as historical context. New mobile product and benchmark work tunes and validates the standard offline VAD route only.
