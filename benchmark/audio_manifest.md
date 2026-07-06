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
