# S2 Physical Interaction Evidence

Date: 2026-07-25
Device: Xiaomi M2102J2SC (Android 13, current midrange reference)
Production package: `com.voice2text.app`

Scope decision `S2-MOBILE-CORE-2026-07-25` reclassifies REC-009 and the
ASR-006/007/008 experiments as `DEFERRED_NOT_PASSED`; their original missing
or failed evidence remains recorded below. S2 Mobile Core still requires the
ASR-005 independent timestamp review and is currently BLOCKED.

This record covers only the interactions performed in this S2 closure run. It
does not reuse the earlier outbound-share evidence as inbound-share evidence,
does not substitute the built-in microphone for an external input device, and
does not treat provisional timestamp annotations as release evidence.

## REC-008: external application share into Voice2Text

Result: **PASS**

1. Installed the production APK and a separate test APK
   (`com.voice2text.app.test`). Android assigned the packages different UIDs
   (`10714` and `10715`).
2. Force-stopped Voice2Text to exercise the cold-start path.
3. The external test activity generated a valid 16 kHz mono WAV and shared a
   read-only `content://com.voice2text.app.test.sender/...` URI using
   `ACTION_SEND`, `audio/wav`, and a temporary read grant.
4. Voice2Text cold-started, consumed the URI, copied it into app-private
   storage, inserted one recording, and enqueued one persistent transcription
   job.

Observed values:

- Source size: `64,044` bytes
- Source SHA-256:
  `073091647e4f2f098c4051c149919e941d513150966d7c2271e30f1a83ed14aa`
- Private-copy size: `64,044` bytes
- Private-copy SHA-256: identical to the source
- Recording: `asset_kind=imported`,
  `source_display_name=external-share-fixture.wav`, `duration_ms=2000`,
  `deletion_state=active`
- Job: one `import_offline` job; the synthetic non-speech fixture reached the
  expected terminal `VAD_FAILED` state. This does not invalidate the completed
  import.

The provider rejects write access, and the source path was not exposed to the
production application.

## REC-009: external recording input

Result: **PENDING — required hardware unavailable**

The connected device reported Bluetooth `STATE_DISCONNECTED`, zero Bluetooth
connections, `mBluetoothHeadsetDevice: null`, USB
`audio_accessory_connected=false`, and no connected wired, Bluetooth, or USB
input descriptor. Only the built-in/system-selected input was available during
the run.

The automated connection, selection, routed-device, disconnect fallback, and
stop-save contracts remain green, but they are not physical external-input
evidence. REC-009 therefore remains historical PENDING and
`DEFERRED_NOT_PASSED` until a real Bluetooth, wired, or USB microphone can be
connected, selected, observed as the actual route, and disconnected during
recording.

## REC-010: marker and note persistence

Result: **PASS**

1. Started a production recording after acknowledging consent and granting the
   Android notification and microphone permissions.
2. Added one marker while recording and saved the note `U10_device_note`.
3. Stopped normally, waited for the offline job to reach terminal failure,
   force-stopped Voice2Text, and cold-started it again.
4. Reopened the new recording from the home list and opened its meeting
   workspace.
5. The timeline showed the marker at `00:12` and the note at `00:28`.
6. Tapping the marker moved the player from `00:00` to `00:12`; tapping the note
   moved it to `00:28`.

Persisted values:

- Recording duration: `42,880 ms`
- Session state: `completed`, stop reason `user_stop`
- Marker position: `12,006 ms`
- Note position: `28,006 ms`
- Job: `standard_offline`, terminal `VAD_FAILED`
- Annotation rows after failure and process restart: `2`

This proves write, save, process restart/reopen, ordered timeline display,
player seek, and retention after transcription failure on the physical device.

## ASR-005 physical production prediction

Result: **ENGINEERING PASS / RELEASE BLOCKED**

Silero parameter sweeps continued to produce one region per clip, and the
installed Paraformer returned no token timestamps. The production engine now
retains Silero as the outer detector and applies a deterministic adaptive
energy split only inside over-broad speech regions.

The updated production engine processed both clips on the Xiaomi:

- `zh_timestamp_window_000`: five segments;
- `en_timestamp_window_000`: four segments;
- prediction SHA-256:
  `01b77e52dd6eadd048a6a2cd91952e7502ad9f6e856010b08d32923a4be1c0d7`;
- tooling-only provisional P95: `182 ms` over 18 boundaries;
- evaluation SHA-256:
  `d94940888f4786e212c3b468a633af84241ad27bee34b3bda22b91e3109d9459`.

The normal evaluator correctly rejects the still-provisional reference before
scoring. The provisional report explicitly sets `releaseEligible=false`;
neither the implementing agent nor the energy-assisted fixture may act as the
independent reviewer. The segment-count mismatch is resolved, but ASR-005
remains BLOCKED until an independent reviewer completes the blind worksheet
and the normal physical evaluation passes P95 ≤ 1.5 seconds.

## ASR-006/007 isolated online-transducer candidate

Result: **LAB SCREENING COMPLETE / RELEASE BLOCKED**

The pinned Apache-2.0 14M streaming Zipformer candidate ran on the Xiaomi
through the installed Sherpa AAR. Its encoder, decoder, joiner, and tokens
hashes are bound to the candidate registry; the four required model files total
25,354,625 bytes. On the fixed 300.655-second Chinese corpus:

- baseline CER/RTF: 4.931% / 0.0780;
- hotword score 1.5 CER/RTF: 4.734% / 0.0994;
- token/timestamp/`ysProbs` arrays were aligned;
- raw score range: -2.598 to -0.060;
- preregistered target-phrase hits: 52 baseline, 52 with hotwords.

Raw report SHA-256:
`7b6c9f0f723d90d37b5de0bf01a9c03e9e3332694f80c54e0fc272a912c7b0c9`.
Evaluator report SHA-256:
`8170f11f4d6708b9c5ec50579326eee80e05d07b90866bda938b29076c5d216e`.

The decoder path measurably changed output, but the required target-term
improvement failed. All observed reference errors were deletions, so there was
no incorrect emitted-token class from which to calibrate confidence. The
candidate remains `lab_only`; it was not added to the product registry,
requests, settings, persistence, or default execution path.

## ASR-008 GTCRN paired production-path evidence

Result: **COMPLETE MID-DEVICE RUN / PREREGISTERED GATES FAILED**

The Xiaomi completed all five deterministic 300.655-second raw/enhanced pairs:
quiet, steady 5 dB noise, burst 0 dB noise, near-talk, and far-talk 5 dB.
`SpeechEnhancementPairedGateTest` finished 5/5 in 1,460.281 seconds.

- raw device report SHA-256:
  `05749363f647b30cf337bf61c0a843cd288937aa7f3ff416835120b231f23362`;
- physical model-identity report SHA-256:
  `2fec9d260f8bedf82edb32b9933442a6a0073e61922eb6823e89d48a197e5bb3`;
- evaluator report SHA-256:
  `b7ae589b0c8494a06c1b5952c462a2a20319a83859d845da9b42474dffa3a14a`;
- quiet CER regression: +0.008876, above the +0.005 limit;
- mean noisy-case CER improvement: +0.002301, below the +0.05 minimum;
- maximum enhancement RTF: 0.327299, above the 0.25 limit;
- maximum combined pipeline RTF: 0.501469, within the 1.0 limit;
- maximum Java/native heap deltas: 62,823,400 / 349,676,096 bytes; native
  exceeded the 134,217,728-byte limit;
- paired boundaries: only 3/5 cases had equal segment counts; maximum P95
  drift was 616 ms, above the 250 ms limit;
- thermal status remained 0; all source fixtures remained byte-identical;
- battery capacity read 100% before/after and the charge counter changed from
  3,150,995 to 3,150,993 µAh; this is observational, not a calibrated
  consumption PASS.

The mid-device candidate already fails mandatory thresholds. Independent
absolute timestamp references, the low-device run, and any AEC implementation
are still absent. GTCRN remains an offline noise-suppression experiment, not
AEC, and production remains fail-closed.
