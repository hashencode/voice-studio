# Desktop processing benchmark

This directory is the target-bound admission boundary for desktop processing.
Benchmark conclusions apply only to the operating-system, architecture, CPU,
memory, native runtime, models, and fixtures named in each evidence file.
Android evidence is never accepted for a macOS decision, and macOS evidence is
never inherited by Windows.

Run the fixed macOS Sherpa baseline:

```bash
(cd apps/desktop && flutter build macos --debug)
./benchmark/desktop/prepare_macos_benchmark_assets.sh
./benchmark/desktop/run_macos_sherpa_baseline.sh
python3 benchmark/desktop/validate_desktop_evidence.py \
  --contract benchmark/desktop/desktop_benchmark_contract.json \
  --evidence-root benchmark/desktop/evidence/macos-sherpa-1.13.4
```

The command-line runner deliberately loads the thinned and signed Sherpa
frameworks from the built app. Loading the unthinned universal pub-cache dylib
is rejected as runtime evidence because its code signature does not verify on
this target.

Sherpa 1.13.4 treats the offline diarization callback as progress-only: its
return value is ignored by the native implementation. Cancellation therefore
uses an isolated worker process. The cancellation probe waits until that worker
has initialized the native diarizer, terminates its process group, verifies that
no partial result was published, and removes the worker's temporary directory.

```bash
python3 benchmark/desktop/run_cancellation_probe.py \
  --root . \
  --reference-evidence \
    benchmark/desktop/evidence/macos-sherpa-1.13.4/diarization-functional.json \
  --evidence-root \
    benchmark/desktop/evidence/macos-sherpa-1.13.4/cancellation
```

Large models, decoded PCM, and temporary output live under ignored `build/`
directories. Only bounded JSON evidence and its SHA-256 index belong here.
The product capability state remains controlled by
`docs/product/desktop-workstation-scope.json`; benchmark success alone does not
open a UI capability.
