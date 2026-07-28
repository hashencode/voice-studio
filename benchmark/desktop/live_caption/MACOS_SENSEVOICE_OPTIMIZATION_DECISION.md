# macOS SenseVoice optimization decision

Status: `CONTROL_RETAINED`

The fixed Apple M4 screening matrix completed the U13 control plus 13
single-variable arms. `vad-threshold-0.4` screened in on the development
fixtures: aggregate error fell from `0.3296807561` to `0.2784151115`,
non-target error fell from `0.3438440670` to `0.2861702168`, and code-switch
error also improved. Short confirmation, non-speech, RSS, backlog, cleanup, and
bounded-utterance gates passed.

The selected arm then completed the frozen held-out pack and a real-time
15-minute stability replay in `933.030897` seconds. It consumed all input,
reported no non-speech hallucination, retained no worker RSS after exit, and
kept maximum backlog at `0.528` seconds. However, held-out aggregate error
regressed from the comparable U13 control `0.3005423416` to `0.3058281961`;
non-target error regressed from `0.3053087159` to `0.3121418270`, beyond the
preregistered `+0.003` limit. Warm utterance P95 also regressed from
`841.294 ms` to `869.553 ms`.

The machine decision therefore retains the U13 product control:

- model: SenseVoice 2024-07-17 int8
- runtime: sherpa-onnx 1.13.4 / ORT 1.27
- provider/threads/concurrency: CPU / 2 / 1
- language/ITN: `auto` / `false`
- VAD: threshold `0.5`, min speech `0.25`, min silence `0.5`, max utterance
  `15` seconds
- publication: finalized VAD utterances only; no token partials

The 2025 model arm remained promotion-ineligible because its upstream license
disposition is unresolved; it also hallucinated on non-speech and regressed
quality. ORT 1.24.4 was faster but exceeded the fixed RSS regression gate.

Evidence bindings:

- contract: `93fd9f1a46a9c7eef740fab19ec7e2a2ac15201318478d7a26ac2ea1b2f56651`
- screening raw: `0971d9eb7125268dea8934226dddf3dc406080e032b68bc89d6fcdd902ec4152`
- screening summary: `044d406fec793ec3852a0d84f90f87869b8e7d44502d6ffdfdb625b2209031eb`
- finalist raw: `0809c3eb3646326e1719a084359c0c921b3bea9a7471231b4304e99310090498`
- finalist summary: `d05eb9a8a0f79836463436211765c47283d3cac776f6d838d29fe4327a54d18b`
- final decision: `6f95c2c70cf36eac26ec0bdc208298e50dfd8d7344cba2623176f9eddb65f320`

This is `DEVELOPMENT_ONLY`. It does not authorize distribution, production
signing, notarization, store submission, or release work.
