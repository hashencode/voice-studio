#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET_SECONDS="${TARGET_SECONDS:-300}"
OUT_AUDIO="$ROOT/build/asr_benchmark/audio"
FIXTURE_AUDIO="$ROOT/benchmark/audio"
SRC_ROOT="$ROOT/build/asr_benchmark/source_audio"
ZH_SRC="$SRC_ROOT/aishell3_samples"
EN_SRC="$SRC_ROOT/librispeech_dev_clean"
LIBRISPEECH_ARCHIVE="$SRC_ROOT/dev-clean.tar.gz"

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path"
    exit 1
  fi
}

if [[ "${REBUILD_FROM_SOURCES:-0}" != "1" ]]; then
  require_file "$FIXTURE_AUDIO/zh.wav"
  require_file "$FIXTURE_AUDIO/zh.txt"
  require_file "$FIXTURE_AUDIO/en.wav"
  require_file "$FIXTURE_AUDIO/en.txt"
  mkdir -p "$OUT_AUDIO"
  cp "$FIXTURE_AUDIO/zh.wav" "$OUT_AUDIO/zh.wav"
  cp "$FIXTURE_AUDIO/zh.txt" "$OUT_AUDIO/zh.txt"
  cp "$FIXTURE_AUDIO/en.wav" "$OUT_AUDIO/en.wav"
  cp "$FIXTURE_AUDIO/en.txt" "$OUT_AUDIO/en.txt"
  echo "Benchmark audio copied from $FIXTURE_AUDIO to $OUT_AUDIO"
  exit 0
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Missing dependency: ffmpeg"
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "Missing dependency: ffprobe"
  exit 1
fi

mkdir -p "$OUT_AUDIO" "$ZH_SRC" "$EN_SRC"

download() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" ]]; then
    return
  fi
  echo "Downloading $(basename "$dest")"
  curl -L --fail --retry 3 -o "$dest" "$url"
}

prepare_zh() {
  echo "[zh] Preparing AISHELL-3 sample-based smoke audio"
  download "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw1.wav" "$ZH_SRC/raw1.wav"
  download "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw2.wav" "$ZH_SRC/raw2.wav"
  download "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw3.wav" "$ZH_SRC/raw3.wav"

  python3 - "$TARGET_SECONDS" "$ZH_SRC" "$OUT_AUDIO" <<'PY'
import subprocess
import sys
from pathlib import Path

target_seconds = float(sys.argv[1])
src = Path(sys.argv[2])
out = Path(sys.argv[3])
items = [
    ("raw1.wav", "在教学楼内释放大量烟雾"),
    ("raw2.wav", "不过英特尔之后不会继续接受如此大的损失"),
    ("raw3.wav", "替我播放相思风雨中"),
]

def duration(path: Path) -> float:
    value = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], text=True).strip()
    return float(value)

durations = {name: duration(src / name) for name, _ in items}
concat_lines = []
transcript = []
elapsed = 0.0
while elapsed < target_seconds:
    for name, text in items:
        concat_lines.append(f"file '{(src / name).as_posix()}'")
        transcript.append(text)
        elapsed += durations[name]
        if elapsed >= target_seconds:
            break

(src / "zh_concat.txt").write_text("\n".join(concat_lines) + "\n")
(out / "zh.txt").write_text("".join(transcript) + "\n")
PY

  ffmpeg -hide_banner -loglevel error -y \
    -f concat -safe 0 -i "$ZH_SRC/zh_concat.txt" \
    -ac 1 -ar 16000 "$OUT_AUDIO/zh.wav"
  echo "[zh] Wrote $OUT_AUDIO/zh.wav and zh.txt"
}

prepare_en() {
  echo "[en] Preparing LibriSpeech dev-clean sample audio"
  download "https://www.openslr.org/resources/12/dev-clean.tar.gz" "$LIBRISPEECH_ARCHIVE"

  if [[ ! -d "$EN_SRC/LibriSpeech/dev-clean" ]]; then
    tar -xzf "$LIBRISPEECH_ARCHIVE" -C "$EN_SRC"
  fi

  python3 - "$TARGET_SECONDS" "$EN_SRC/LibriSpeech/dev-clean" "$OUT_AUDIO" <<'PY'
import subprocess
import sys
from pathlib import Path

target_seconds = float(sys.argv[1])
root = Path(sys.argv[2])
out = Path(sys.argv[3])

transcripts = {}
for trans_file in sorted(root.glob("*/*/*.trans.txt")):
    for line in trans_file.read_text().splitlines():
        if not line.strip():
            continue
        utt_id, text = line.split(" ", 1)
        transcripts[utt_id] = text.strip()

def duration(path: Path) -> float:
    value = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], text=True).strip()
    return float(value)

concat_lines = []
texts = []
elapsed = 0.0
for flac in sorted(root.glob("*/*/*.flac")):
    utt_id = flac.stem
    text = transcripts.get(utt_id)
    if not text:
        continue
    concat_lines.append(f"file '{flac.as_posix()}'")
    texts.append(text)
    elapsed += duration(flac)
    if elapsed >= target_seconds:
        break

if not concat_lines:
    raise SystemExit("No LibriSpeech utterances found")

(out / "en_concat.txt").write_text("\n".join(concat_lines) + "\n")
(out / "en.txt").write_text(" ".join(texts) + "\n")
PY

  ffmpeg -hide_banner -loglevel error -y \
    -f concat -safe 0 -i "$OUT_AUDIO/en_concat.txt" \
    -ac 1 -ar 16000 "$OUT_AUDIO/en.wav"
  rm -f "$OUT_AUDIO/en_concat.txt"
  echo "[en] Wrote $OUT_AUDIO/en.wav and en.txt"
}

prepare_zh
prepare_en

echo "Benchmark audio ready under $OUT_AUDIO"
