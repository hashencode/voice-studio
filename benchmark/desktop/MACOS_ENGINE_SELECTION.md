# macOS engine selection

Decision ID: `desktop-processing/macos-first-engine-set-v1`

Status: `FINALISTS_FROZEN`

Machine decision: `benchmark/desktop/desktop_model_candidates.json`

## Frozen combination

- ASR winner: `sherpa-streaming-zipformer-zh-14m-2023-02-23`
- Diarization winner: `sherpa-pyannote-3.0-3dspeaker`
- Runtime: `sherpa-onnx-c-api@1.13.4`
- Isolation boundary: `native_worker_process_group`
- Frozen diarization clustering threshold: `0.65`
- Frozen worker threads: `2` per native worker on the 8-logical-core Apple M2 reference target
- Long-meeting execution: two concurrent half-duration workers with a
  120-second overlap above the 60-minute threshold
- Sidecar winner: `null`

The first product set therefore stays on one pinned native Sherpa runtime. The
worker-process boundary, rather than an in-process callback, owns cancellation
and resource termination. No Python runtime or global Python dependency enters
the selected product path.

## ASR comparison

Both candidates used `fixed-zh-meeting-300s` on Apple M2, macOS 15.7.5,
arm64, 16 GiB:

| Candidate | CER | RTF including cold start | Incremental peak RSS | Model payload |
| --- | ---: | ---: | ---: | ---: |
| Sherpa Zipformer 14M | 0.035503 | 0.020462 | n/a in the U5 ASR probe | 25,354,851 bytes |
| FunASR 1.3.22 Paraformer + FSMN VAD + CT punctuation | 0.116371 | 0.202825 | 3,130,687,488 bytes | 1,209,984,868 bytes |

The FunASR run exercised real Paraformer, VAD, punctuation, ITN request and
941 timestamps and passed the absolute CER/RTF gates. It is not selected because
all measured trade-offs move in the wrong direction: `QUALITY_REGRESSION_VS_SHERPA`,
`RTF_REGRESSION_VS_SHERPA`, `DELIVERY_FOOTPRINT_COST_NOT_JUSTIFIED`, and
`PEAK_RSS_COST_NOT_JUSTIFIED`. Its measured Python environment adds another
930,474,501 bytes before the standalone interpreter bundle. There is no quality
benefit that could justify the packaging, startup, memory and maintenance cost.

## Diarization comparison

Sherpa completed the five-minute functional probe and the full 7,200-second
resource probe. Its resource RTF is 0.274567 and incremental peak RSS is
216,252,416 bytes. The selected segmentation archive includes the MIT license;
the pinned 3D-Speaker ERes2Net model is Apache-2.0. Product delivery must retain
both notices and must continue to expose anonymous speaker labels only, without
persisting voiceprints.

U9 re-ran the product worker on five fixed 60-second windows from the pinned
real-source fixture. A preregistered sweep of the clustering threshold
(`0.35`, `0.40`, `0.45`, `0.50`, `0.55`, `0.60`, `0.65`) changed no runtime,
model, fixture, ASR, or scoring rule. `0.65` reduced the aggregate anonymous
speaker assignment correction rate from `15.03%` at `0.50` to `7.996%`
(`73/913`), satisfying the macOS product experience gate. The threshold is now
part of the frozen product worker configuration and is not user-selectable.
The U5 benchmark contract remains the preregistered two-thread comparison
baseline. U9's complete two-hour experience gate showed that a single worker
cannot finish full ASR plus diarization within 30 minutes, while four threads in
one worker reduced throughput. The product therefore keeps the verified
two-thread setting and, only above 60 minutes, runs two half-duration
diarization workers concurrently. Their 120-second overlap aligns anonymous
speaker labels before results are cut at the midpoint and joined without
duplicate turns. One job still owns cancellation and publication, no
voiceprints are persisted, and shorter meetings keep the single-worker path.
This is a target-specific execution decision, not a change to the U5 candidate
ranking or evidence.

`pyannote/speaker-diarization-community-1` is pinned at
`3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`, but remains
`LAB_ONLY_USER_CONDITIONS_NOT_ACCEPTED`. Its hard failures are
`USER_CONDITIONS_NOT_ACCEPTED`, `MODEL_CONTENT_NOT_PROVISIONED`, and
`FFMPEG_DELIVERY_NOT_FROZEN`. No user conditions were accepted and no token was
requested or inherited. Hard failures were applied before considering quality.

## Delivery and verification boundary

The versioned JSONL sidecar contract remains a reusable benchmark boundary. It
fail-closes handshake/capability drift, stale attempts, path escape, output
overflow and crashes; the macOS sandbox denies processing network and user-home
data outside the job/runtime/model/tool roots. Its runtime manager verifies
content hashes and target/license conditions, resumes staging, atomically
activates versions, repairs by quarantine, rolls back, prunes and uninstalls.
Because `sidecarWinner=null`, no candidate Python runtime is admitted to product
delivery.

The selected native path already has a hash-pinned Xcode-thinned runtime staging
decision and an offline full-meeting vertical slice from U5. U6 additionally
proves candidate provisioning mechanics and sandbox/resource-failure behavior;
U7 must productize the selected native worker-process boundary without widening
the model set.
