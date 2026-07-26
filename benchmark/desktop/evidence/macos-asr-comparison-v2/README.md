# macOS ASR comparison v2 evidence

`smoke/` is a committed, privacy-validated, **non-ranked** evidence package for
the U1–U6 implementation. It proves that the versioned contract can prepare a
committed fixture, run a fresh-process worker matrix with one warm-up and five
measured repetitions, score and aggregate the observations, exercise failure
and sandbox probes, validate the publishable payload, and activate a
content-addressed version atomically.

The package deliberately contains no audio, PCM, transcript or hypothesis
text, tokens, embeddings, voiceprints, secrets, absolute paths, or private
labels. `rankEligible` is false at the index, document, aggregate, and run
levels. The fake worker is contract-test infrastructure, not an eighth model
candidate and not quality or model-performance evidence.

Regenerate and validate from the repository root:

```bash
python3 tool/build_cache_guard.py
build/desktop_asr_comparison/orchestration-env/bin/python \
  benchmark/desktop/asr_comparison/run_macos_asr_comparison.py \
  --root "$PWD" --fake-smoke

python3 tool/build_cache_guard.py
build/desktop_asr_comparison/orchestration-env/bin/python \
  benchmark/desktop/asr_comparison/build_smoke_evidence.py \
  --root "$PWD" \
  --output benchmark/desktop/evidence/macos-asr-comparison-v2/smoke \
  --publication-root build/desktop_asr_comparison/publication

build/desktop_asr_comparison/orchestration-env/bin/python \
  benchmark/desktop/asr_comparison/validate_evidence.py \
  --evidence-root benchmark/desktop/evidence/macos-asr-comparison-v2/smoke
```

## Ranked execution prerequisites

U7 and U8 were not executed. Before development or held-out ranking:

1. Provision every candidate in the frozen seven-candidate registry, verify
   every model/component hash, and complete the recorded license reviews.
2. Prepare the local-only development and held-out packs from authorized
   sources, complete reference/variety review, and pass group-leakage checks.
3. Pass Stage 0 admission and the development-only pilot on the frozen target.
4. Freeze the target, runtime lane, profiles, fixture/reference hashes, scorer,
   materiality rule, and worker hashes before any held-out decode.
5. Run the two-hour finalist only in U8. Repeat it when any hard measured metric
   is within 10% of its limit; retain both runs.

Raw worker JSONL and local/private assets remain under ignored `build/` paths
and are never part of this evidence package.
