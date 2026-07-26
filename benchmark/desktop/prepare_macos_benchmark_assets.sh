#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="$ROOT/build/desktop_benchmark"
ARCHIVE="$CACHE/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
MODEL="$CACHE/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
ARCHIVE_SHA="2cbd71b640d9c37d3784f29367333a4577b0398b62e9deeed418170b081cba8b"

mkdir -p "$CACHE"
if [[ ! -f "$ARCHIVE" ]] ||
  [[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" != "$ARCHIVE_SHA" ]]; then
  partial="$ARCHIVE.partial"
  rm -f "$partial"
  curl -fL --retry 3 --connect-timeout 30 --max-time 1800 -o "$partial" "$URL"
  test "$(stat -f '%z' "$partial")" = "74004050"
  test "$(shasum -a 256 "$partial" | awk '{print $1}')" = "$ARCHIVE_SHA"
  mv "$partial" "$ARCHIVE"
fi

python3 - "$ARCHIVE" "$MODEL" <<'PY'
import hashlib
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

archive = Path(sys.argv[1])
target = Path(sys.argv[2])
prefix = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/"
required = {
    "encoder-epoch-99-avg-1.int8.onnx":
        "1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1",
    "decoder-epoch-99-avg-1.int8.onnx":
        "22f123bb8cba9b38974b3df18a3f45e7081f4985ebb2e075d9f21f618c468bbf",
    "joiner-epoch-99-avg-1.int8.onnx":
        "a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169",
    "tokens.txt":
        "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac",
    "README.md":
        "515751f07faad368f0863ae41773ff09635eba5920122d549abb8e45d5c88282",
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

if target.is_dir() and all(
    (target / name).is_file() and sha(target / name) == expected
    for name, expected in required.items()
):
    raise SystemExit(0)

with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
    prepared = Path(temporary) / target.name
    prepared.mkdir()
    found = set()
    with tarfile.open(archive, "r:bz2") as source:
        for member in source:
            if not member.name.startswith(prefix):
                continue
            name = member.name[len(prefix):]
            if name not in required:
                continue
            if not member.isfile():
                raise SystemExit(f"required member is not a file: {name}")
            extracted = source.extractfile(member)
            if extracted is None:
                raise SystemExit(f"cannot read {name}")
            with extracted, (prepared / name).open("wb") as output:
                shutil.copyfileobj(extracted, output)
            found.add(name)
    if found != set(required):
        raise SystemExit(f"missing required members: {set(required) - found}")
    for name, expected in required.items():
        if sha(prepared / name) != expected:
            raise SystemExit(f"hash mismatch: {name}")
    if target.exists():
        shutil.rmtree(target)
    prepared.replace(target)
PY

echo "macOS benchmark assets ready under $CACHE"

SPEAKER="$ROOT/build/speaker_diarization"
mkdir -p "$SPEAKER/models" "$SPEAKER/sources" "$SPEAKER/fixtures"

download() {
  local url="$1"
  local destination="$2"
  local expected_sha="$3"
  mkdir -p "$(dirname "$destination")"
  if [[ ! -f "$destination" ]] ||
    [[ "$(shasum -a 256 "$destination" | awk '{print $1}')" != "$expected_sha" ]]; then
    partial="$destination.partial"
    rm -f "$partial"
    curl -fL --retry 3 --connect-timeout 30 --max-time 1800 \
      -o "$partial" "$url"
    test "$(shasum -a 256 "$partial" | awk '{print $1}')" = "$expected_sha"
    mv "$partial" "$destination"
  fi
}

SEGMENTATION_ARCHIVE="$SPEAKER/models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
  "$SEGMENTATION_ARCHIVE" \
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
tar -xjf "$SEGMENTATION_ARCHIVE" -C "$SPEAKER/models"
test "$(shasum -a 256 "$SPEAKER/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" | awk '{print $1}')" = \
  "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  "$SPEAKER/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker1_a_cn_16k.wav" \
  "$SPEAKER/sources/speaker1_a_cn_16k.wav" \
  "5f20ce0ddc378ca3239d3ce864b1142726a46a1221ae553912e4e142045df58b"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker1_b_cn_16k.wav" \
  "$SPEAKER/sources/speaker1_b_cn_16k.wav" \
  "20745dc08a4281894d146140b99b9ef7417ac681119b7f7202f553cdf1a85f65"
download \
  "https://modelscope.cn/api/v1/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k/repo?Revision=master&FilePath=examples/speaker2_a_cn_16k.wav" \
  "$SPEAKER/sources/speaker2_a_cn_16k.wav" \
  "8a6cffa452df32ef10503f7992f22ffcdd7f16c4e0273d13311bc5cdcb13abf4"

python3 "$ROOT/benchmark/prepare_speaker_diarization_fixtures.py" \
  --manifest "$ROOT/benchmark/speaker_diarization_admission_contract.json" \
  >/dev/null
test "$(shasum -a 256 "$SPEAKER/fixtures/speaker-functional-5m.wav" | awk '{print $1}')" = \
  "7e2757eb30176edc36a2c14a6511bbf297caa5dbfa9541e119cd94fd23a6d4ec"
test "$(shasum -a 256 "$SPEAKER/fixtures/speaker-resource-120m.wav" | awk '{print $1}')" = \
  "6a4f0849cee47ad9daecac04d92977c8cf6b48de1dd43849ad60852de5b336c3"

echo "speaker benchmark assets ready under $SPEAKER"
