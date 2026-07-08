#!/usr/bin/env python3
"""Prepare ASR validation and length-decision audio sets.

Generated audio and manifests are written under build/asr_benchmark so they are
repeatable without committing binary artifacts.
"""

from __future__ import annotations

import argparse
import array
import json
import shutil
import sys
import tarfile
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_FILE = ROOT / "benchmark" / "asr_benchmark_manifest.json"
DEFAULT_AUDIO_ROOT = ROOT / "benchmark" / "audio"
DEFAULT_OUTPUT_ROOT = ROOT / "build" / "asr_benchmark" / "validation_audio"
DEFAULT_DIAGNOSTICS_DIR = ROOT / "build" / "asr_benchmark" / "diagnostics"
DEFAULT_ARCHIVE_DIR = ROOT / "build" / "asr_benchmark" / "archives"
SOURCE_AUDIO_DIR = ROOT / "build" / "asr_benchmark" / "source_audio"

EN_MODEL_ID = "paraformer-en-2024-03-09"
EN_ARCHIVE_NAME = "sherpa-onnx-paraformer-en-2024-03-09.tar.bz2"
EN_ARCHIVE_DIR = "sherpa-onnx-paraformer-en-2024-03-09"
EN_OFFICIAL_WAVS = ("0.wav", "1.wav")

ZH_SOURCES = (
    (
        "raw1.wav",
        "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw1.wav",
        "在教学楼内释放大量烟雾",
    ),
    (
        "raw2.wav",
        "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw2.wav",
        "不过英特尔之后不会继续接受如此大的损失",
    ),
    (
        "raw3.wav",
        "https://sos1sos2sixteen.github.io/aishell3/audios/raw/raw3.wav",
        "替我播放相思风雨中",
    ),
)
TARGET_SAMPLE_RATE = 16000


@dataclass(frozen=True)
class AudioCase:
    id: str
    language: str
    wav: str
    reference: str

    def to_json(self) -> dict[str, str]:
        return {
            "id": self.id,
            "language": self.language,
            "wav": self.wav,
            "reference": self.reference,
        }


@dataclass(frozen=True)
class SourceClip:
    path: Path
    text: str


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def load_base_manifest() -> dict[str, object]:
    return json.loads(MANIFEST_FILE.read_text())


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def copy_default_audio(output_root: Path) -> list[AudioCase]:
    cases: list[AudioCase] = []
    for language in ("zh", "en"):
        out_dir = output_root / "default"
        wav = out_dir / f"{language}.wav"
        ref = out_dir / f"{language}.txt"
        wav.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEFAULT_AUDIO_ROOT / f"{language}.wav", wav)
        shutil.copy2(DEFAULT_AUDIO_ROOT / f"{language}.txt", ref)
        cases.append(
            AudioCase(
                id=language,
                language=language,
                wav=relative(wav, output_root),
                reference=relative(ref, output_root),
            )
        )
    return cases


def official_en_archive(archive_dir: Path) -> Path:
    archive = archive_dir / EN_ARCHIVE_NAME
    if not archive.is_file():
        raise SystemExit(
            "Missing official English archive. Run: "
            f"./benchmark/download_asr_benchmark_models.sh {EN_MODEL_ID}"
        )
    return archive


def prepare_official_en(output_root: Path, archive_dir: Path) -> tuple[list[AudioCase], list[SourceClip]]:
    archive = official_en_archive(archive_dir)
    out_dir = output_root / "official_en"
    out_dir.mkdir(parents=True, exist_ok=True)
    base = f"{EN_ARCHIVE_DIR}/test_wavs"
    cases: list[AudioCase] = []
    clips: list[SourceClip] = []

    with tarfile.open(archive, "r:bz2") as handle:
        trans_member = handle.extractfile(f"{base}/trans.txt")
        if trans_member is None:
            raise SystemExit(f"Missing official transcript in {archive}")
        references: dict[str, str] = {}
        for line in trans_member.read().decode("utf-8").splitlines():
            if not line.strip():
                continue
            name, text = line.split(" ", 1)
            references[name] = text.strip()

        for wav_name in EN_OFFICIAL_WAVS:
            if wav_name not in references:
                raise SystemExit(f"Missing reference for official English audio: {wav_name}")
            wav_member = handle.extractfile(f"{base}/{wav_name}")
            if wav_member is None:
                raise SystemExit(f"Missing official English audio: {wav_name}")
            stem = Path(wav_name).stem
            wav_path = out_dir / wav_name
            ref_path = out_dir / f"{stem}.txt"
            wav_path.write_bytes(wav_member.read())
            write_text(ref_path, references[wav_name])
            case = AudioCase(
                id=f"en_official_{stem}",
                language="en",
                wav=relative(wav_path, output_root),
                reference=relative(ref_path, output_root),
            )
            cases.append(case)
            clips.append(SourceClip(wav_path, references[wav_name]))

    return cases, clips


def download_file(url: str, dest: Path) -> None:
    if dest.is_file():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        dest.write_bytes(response.read())


def read_pcm_samples(path: Path) -> tuple[list[int], int]:
    with wave.open(str(path), "rb") as handle:
        if handle.getcomptype() != "NONE":
            raise SystemExit(f"Unsupported compressed WAV: {path}")
        if handle.getsampwidth() != 2:
            raise SystemExit(f"Unsupported WAV sample width in {path}: {handle.getsampwidth()}")
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        payload = handle.readframes(handle.getnframes())

    samples = array.array("h")
    samples.frombytes(payload)
    if sys.byteorder != "little":
        samples.byteswap()

    if channels == 1:
        return list(samples), sample_rate
    if channels <= 0:
        raise SystemExit(f"Invalid channel count in {path}: {channels}")

    mono: list[int] = []
    values = list(samples)
    for index in range(0, len(values), channels):
        frame = values[index : index + channels]
        mono.append(round(sum(frame) / len(frame)))
    return mono, sample_rate


def resample_linear(samples: list[int], source_rate: int, target_rate: int) -> list[int]:
    if source_rate == target_rate:
        return samples
    if not samples:
        return samples
    output_count = max(1, round(len(samples) * target_rate / source_rate))
    output: list[int] = []
    for index in range(output_count):
        position = index * source_rate / target_rate
        left = int(position)
        right = min(left + 1, len(samples) - 1)
        fraction = position - left
        value = samples[left] * (1.0 - fraction) + samples[right] * fraction
        output.append(max(-32768, min(32767, round(value))))
    return output


def write_pcm_wav(path: Path, samples: list[int], sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = array.array("h", samples)
    if sys.byteorder != "little":
        payload.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(payload.tobytes())


def normalize_wav(source: Path, target: Path, sample_rate: int = TARGET_SAMPLE_RATE) -> None:
    samples, source_rate = read_pcm_samples(source)
    write_pcm_wav(target, resample_linear(samples, source_rate, sample_rate), sample_rate)


def prepare_zh_sources(output_root: Path, allow_download: bool) -> tuple[AudioCase, list[SourceClip]]:
    source_dir = SOURCE_AUDIO_DIR / "aishell3_samples"
    out_dir = output_root / "zh_validation"
    out_dir.mkdir(parents=True, exist_ok=True)
    clips: list[SourceClip] = []
    for name, url, text in ZH_SOURCES:
        source = source_dir / name
        if not source.is_file():
            if not allow_download:
                raise SystemExit(f"Missing Chinese source audio: {source}")
            download_file(url, source)
        target = out_dir / name
        normalize_wav(source, target)
        clips.append(SourceClip(target, text))

    first = clips[0]
    ref = out_dir / "raw1.txt"
    write_text(ref, first.text)
    return (
        AudioCase(
            id="zh_validation_aishell_raw1",
            language="zh",
            wav=relative(first.path, output_root),
            reference=relative(ref, output_root),
        ),
        clips,
    )


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / float(handle.getframerate())


def concatenate_wav(clips: list[SourceClip], target_seconds: float, wav_path: Path, ref_path: Path) -> None:
    if not clips:
        raise SystemExit("No clips available for concatenation")

    wav_path.parent.mkdir(parents=True, exist_ok=True)
    ref_path.parent.mkdir(parents=True, exist_ok=True)

    params = None
    texts: list[str] = []
    elapsed = 0.0
    sequence: list[SourceClip] = []
    while elapsed < target_seconds:
        for clip in clips:
            sequence.append(clip)
            texts.append(clip.text)
            elapsed += wav_duration(clip.path)
            if elapsed >= target_seconds:
                break

    with wave.open(str(wav_path), "wb") as output:
        for clip in sequence:
            with wave.open(str(clip.path), "rb") as source:
                if params is None:
                    params = source.getparams()
                    output.setparams(params)
                elif source.getparams()[:3] != params[:3] or source.getcomptype() != params.comptype:
                    raise SystemExit(
                        "Cannot concatenate WAV files with different channel/sample-rate/sample-width params: "
                        f"{clip.path}"
                    )
                output.writeframes(source.readframes(source.getnframes()))

    write_text(ref_path, " ".join(texts))


def prepare_length_cases(
    output_root: Path,
    zh_clips: list[SourceClip],
    en_clips: list[SourceClip],
    lengths: list[int],
) -> list[AudioCase]:
    cases: list[AudioCase] = []
    for language, clips in (("zh", zh_clips), ("en", en_clips)):
        for seconds in lengths:
            out_dir = output_root / "length_decision" / language
            wav_path = out_dir / f"{language}_len_{seconds}s.wav"
            ref_path = out_dir / f"{language}_len_{seconds}s.txt"
            concatenate_wav(clips, seconds, wav_path, ref_path)
            cases.append(
                AudioCase(
                    id=f"{language}_len_{seconds}s",
                    language=language,
                    wav=relative(wav_path, output_root),
                    reference=relative(ref_path, output_root),
                )
            )
    return cases


def write_manifest(
    output: Path,
    audio_cases: list[AudioCase],
    model_ids: set[str] | None = None,
) -> None:
    manifest = load_base_manifest()
    if model_ids:
        manifest["models"] = [model for model in manifest["models"] if model["id"] in model_ids]
    manifest["audioCases"] = [case.to_json() for case in audio_cases]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def validate_manifest(manifest_path: Path, audio_root: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    for audio_case in manifest["audioCases"]:
        for key in ("wav", "reference"):
            path = audio_root / audio_case[key]
            if not path.is_file():
                raise SystemExit(f"Manifest references missing {key}: {path}")


def parse_lengths(value: str) -> list[int]:
    lengths = [int(item.strip()) for item in value.split(",") if item.strip()]
    if not lengths:
        raise argparse.ArgumentTypeError("Pass at least one length in seconds")
    if any(length <= 0 for length in lengths):
        raise argparse.ArgumentTypeError("Lengths must be positive seconds")
    return lengths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["all", "official", "validation", "length"],
        default="all",
        help="Which manifest/audio set to prepare.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Audio root for generated validation files.",
    )
    parser.add_argument(
        "--diagnostics-dir",
        type=Path,
        default=DEFAULT_DIAGNOSTICS_DIR,
        help="Directory for generated manifests.",
    )
    parser.add_argument(
        "--archive-dir",
        type=Path,
        default=DEFAULT_ARCHIVE_DIR,
        help="Directory containing downloaded model archives.",
    )
    parser.add_argument(
        "--length-seconds",
        type=parse_lengths,
        default=parse_lengths("15,30,60,120,300,600"),
        help="Comma-separated target durations for the length-decision manifest.",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Do not download Chinese source samples if they are missing.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_root = args.output_root.resolve()
    diagnostics_dir = args.diagnostics_dir.resolve()
    archive_dir = args.archive_dir.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    diagnostics_dir.mkdir(parents=True, exist_ok=True)

    official_cases, en_clips = prepare_official_en(output_root, archive_dir)
    zh_case = None
    zh_clips: list[SourceClip] = []
    default_cases: list[AudioCase] = []
    if args.mode in ("all", "validation", "length"):
        zh_case, zh_clips = prepare_zh_sources(output_root, allow_download=not args.no_download)
    if args.mode in ("all", "validation"):
        default_cases = copy_default_audio(output_root)

    outputs: list[Path] = []
    if args.mode in ("all", "official"):
        official_manifest = diagnostics_dir / "asr-official-en-manifest.json"
        write_manifest(official_manifest, official_cases, model_ids={EN_MODEL_ID})
        validate_manifest(official_manifest, output_root)
        outputs.append(official_manifest)

    if args.mode in ("all", "validation"):
        validation_manifest = diagnostics_dir / "asr-validation-manifest.json"
        if zh_case is None:
            raise SystemExit("Chinese validation case was not prepared")
        validation_cases = default_cases + [zh_case] + official_cases
        write_manifest(validation_manifest, validation_cases)
        validate_manifest(validation_manifest, output_root)
        outputs.append(validation_manifest)

    if args.mode in ("all", "length"):
        length_manifest = diagnostics_dir / "asr-length-decision-manifest.json"
        if not zh_clips:
            raise SystemExit("Chinese length source clips were not prepared")
        length_cases = prepare_length_cases(output_root, zh_clips, en_clips, args.length_seconds)
        write_manifest(length_manifest, length_cases)
        validate_manifest(length_manifest, output_root)
        outputs.append(length_manifest)

    print(f"Audio root: {output_root}")
    for output in outputs:
        manifest = json.loads(output.read_text())
        print(f"Wrote {output} ({len(manifest['audioCases'])} audio cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
