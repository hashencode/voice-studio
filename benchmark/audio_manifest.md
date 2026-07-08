# ASR Benchmark Audio Manifest

The default benchmark audio is committed under `benchmark/audio/` so repeat runs do not need internet search or large corpus downloads.

```text
benchmark/audio/
  zh.wav
  zh.txt
  en.wav
  en.txt
```

All wav files are mono 16kHz PCM. The native runner can handle other sample rates through Sherpa, but fixed 16kHz fixtures make model-to-model and run-to-run comparisons simpler.

## Chinese Fixture

- Audio: `benchmark/audio/zh.wav`
- Reference: `benchmark/audio/zh.txt`
- Duration: about 300.655s
- Source basis: AISHELL-3 public sample wavs repeated into long-form smoke audio.

`zh.txt` is plain Chinese text without timestamps. Punctuation and whitespace are stripped by the CER normalizer.

## English Fixture

- Audio: `benchmark/audio/en.wav`
- Reference: `benchmark/audio/en.txt`
- Duration: about 304.605s
- Source basis: LibriSpeech `dev-clean` utterances concatenated into long-form smoke audio.

`en.txt` is plain English text without timestamps. The WER normalizer lowercases text, strips punctuation, and compares whitespace-separated words.

## Rebuilding Fixtures

The committed fixtures should be used for normal benchmark work. To intentionally rebuild local audio from public sources:

```bash
REBUILD_FROM_SOURCES=1 ./benchmark/prepare_asr_benchmark_audio.sh
```

That path downloads the public source audio into `build/asr_benchmark/source_audio/` and writes regenerated files under `build/asr_benchmark/audio/`. It does not update committed fixtures automatically.

## Generated Validation Audio

Validation and length audio is generated into `build/asr_benchmark/validation_audio/`:

```bash
./benchmark/prepare_asr_validation_audio.py --mode all
```

Generated manifests are written under `build/asr_benchmark/diagnostics/`:

- `asr-official-en-manifest.json`: official English `0.wav` and `1.wav` extracted from the Paraformer English archive.
- `asr-validation-manifest.json`: committed long zh/en fixtures copied into the generated audio root, one AISHELL Chinese validation case, and two official English validation cases.
- `asr-length-decision-manifest.json`: generated zh/en complete-audio cases targeting 15s, 30s, 60s, 120s, 300s, and 600s.

All generated validation WAV files are normalized to mono 16kHz PCM.
Only ordinary 16kHz audio with reference text is part of the current benchmark standard.

Chinese official model `test_wavs` are not used for CER scoring because the current archive does not include reference transcripts.
