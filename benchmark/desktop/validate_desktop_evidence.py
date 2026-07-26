#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

HEX64 = re.compile(r"^[0-9a-f]{64}$")


class EvidenceError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"{path}: root must be an object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reject_private_payload(value: Any, location: str = "$") -> None:
    forbidden = {
        "absolutePath", "audio", "audioPayload", "embedding", "embeddings",
        "path", "pcm", "pcmPayload", "voiceprint", "voiceprints",
    }
    if isinstance(value, dict):
        for key, child in value.items():
            require(key not in forbidden, f"{location}: forbidden field {key}")
            reject_private_payload(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_private_payload(child, f"{location}[{index}]")
    elif isinstance(value, str):
        require(
            not value.startswith("/") and not re.match(r"^[A-Za-z]:[\\/]", value),
            f"{location}: absolute paths are forbidden",
        )


def validate_fingerprint(
    evidence: dict[str, Any], contract: dict[str, Any]
) -> None:
    fingerprint = evidence.get("targetFingerprint")
    require(isinstance(fingerprint, dict), "targetFingerprint is required")
    required = {
        "operatingSystem", "operatingSystemVersion", "architecture", "cpuModel",
        "logicalCpuCount", "memoryBytes", "runtimeId", "runtimeVersion",
        "runtimeSha256",
    }
    require(set(fingerprint) == required, "targetFingerprint fields mismatch")
    require(
        fingerprint["operatingSystem"] == contract["decisionPlatform"],
        "evidence is for the wrong operating system",
    )
    require(
        fingerprint["architecture"] in {"arm64", "x86_64"},
        "unsupported macOS architecture",
    )
    require(bool(fingerprint["operatingSystemVersion"]), "OS version missing")
    require(bool(fingerprint["cpuModel"]), "CPU model missing")
    require(
        isinstance(fingerprint["logicalCpuCount"], int)
        and fingerprint["logicalCpuCount"] > 0,
        "logical CPU count invalid",
    )
    require(
        isinstance(fingerprint["memoryBytes"], int)
        and fingerprint["memoryBytes"] >= 4 * 1024**3,
        "memory fingerprint invalid",
    )
    runtime = contract["runtime"]
    for key in ("runtimeId", "runtimeVersion", "runtimeSha256"):
        expected_key = {
            "runtimeId": "id",
            "runtimeVersion": "version",
            "runtimeSha256": "sha256",
        }[key]
        require(
            fingerprint[key] == runtime[expected_key],
            f"{key} does not match the contract",
        )


def validate_common(
    evidence: dict[str, Any], contract: dict[str, Any], probe: str
) -> None:
    require(evidence.get("schemaVersion") == 1, f"{probe}: schemaVersion")
    require(evidence.get("contractId") == contract["contractId"], "contractId")
    require(evidence.get("source") == contract["source"], "source mismatch")
    require(evidence.get("probe") == probe, "probe mismatch")
    require(evidence.get("complete") is True, f"{probe}: evidence incomplete")
    require(evidence.get("timedOut") is False, f"{probe}: timed out")
    require(evidence.get("cancelled") is False, f"{probe}: cancelled")
    require(evidence.get("temporaryArtifactsReleased") is True, "temp leak")
    configuration = evidence.get("configuration")
    require(isinstance(configuration, dict), "probe configuration missing")
    require(
        configuration.get("numThreads")
        == contract["benchmarkConfiguration"]["numThreads"],
        "numThreads does not match the frozen contract",
    )
    validate_fingerprint(evidence, contract)
    reject_private_payload(evidence)


def validate_models(
    evidence: dict[str, Any], contract: dict[str, Any], role: str
) -> None:
    models = evidence.get("models")
    require(isinstance(models, list) and models, "models are required")
    for model in models:
        require(isinstance(model, dict), "model identity invalid")
        require(HEX64.match(str(model.get("sha256", ""))) is not None, "model hash")
        require(bool(model.get("id")), "model id missing")
        require(bool(model.get("version")), "model version missing")
        require(bool(model.get("licenseDisposition")), "model license missing")
    actual = [{"id": model["id"], "sha256": model["sha256"]} for model in models]
    require(actual == contract["models"][role], f"{role} model identity mismatch")


def validate_asr(evidence: dict[str, Any], contract: dict[str, Any]) -> None:
    validate_common(evidence, contract, "asr")
    validate_models(evidence, contract, "asr")
    fixture = evidence.get("fixture")
    gate = contract["gates"]["asr"]
    require(isinstance(fixture, dict), "ASR fixture missing")
    require(fixture.get("id") == gate["fixtureId"], "ASR fixture id mismatch")
    require(
        fixture.get("sha256") == gate["fixtureSha256"], "ASR fixture hash mismatch"
    )
    duration = fixture.get("durationSeconds")
    require(isinstance(duration, (int, float)) and duration > 0, "ASR duration")
    segments = evidence.get("segments")
    require(isinstance(segments, list) and segments, "ASR segments missing")
    previous = 0.0
    for segment in segments:
        start = segment.get("startSeconds")
        end = segment.get("endSeconds")
        require(
            isinstance(start, (int, float)) and isinstance(end, (int, float)),
            "ASR timestamp type",
        )
        require(0 <= start < end <= duration + 0.001, "ASR timestamp out of bounds")
        require(start >= previous, "ASR timestamps unordered")
        require(bool(str(segment.get("text", "")).strip()), "ASR empty text")
        previous = start
    metrics = evidence.get("metrics", {})
    require(metrics.get("cer") <= gate["maxCer"], "ASR CER gate failed")
    require(metrics.get("rtf") <= gate["maxRtf"], "ASR RTF gate failed")


def validate_diarization(
    evidence: dict[str, Any], contract: dict[str, Any], probe: str
) -> None:
    validate_common(evidence, contract, probe)
    validate_models(evidence, contract, "diarization")
    gate = contract["gates"]["diarization"]
    fixture = evidence.get("fixture")
    require(isinstance(fixture, dict), "diarization fixture missing")
    if probe == "diarization-functional":
        require(fixture.get("id") == gate["functionalFixtureId"], "fixture id")
        require(
            fixture.get("sha256") == gate["functionalFixtureSha256"],
            "functional fixture hash",
        )
        segments = evidence.get("segments")
        require(isinstance(segments, list) and segments, "speaker segments missing")
        duration = fixture.get("durationSeconds")
        speakers = {segment.get("speakerKey") for segment in segments}
        require(len(speakers) >= 2, "functional probe did not separate two speakers")
        overlap_represented = any(
            left.get("speakerKey") != right.get("speakerKey")
            and left.get("startSeconds", -1) < right.get("endSeconds", -1)
            and right.get("startSeconds", -1) < left.get("endSeconds", -1)
            for index, left in enumerate(segments)
            for right in segments[index + 1:]
        )
        require(overlap_represented, "functional probe did not represent overlap")
        for segment in segments:
            require(
                0 <= segment.get("startSeconds", -1)
                < segment.get("endSeconds", -1)
                <= duration + 0.001,
                "speaker timestamp out of bounds",
            )
            require(
                re.match(r"^speaker_[0-9]{2,}$", segment.get("speakerKey", "")),
                "speaker key must be anonymous",
            )
        suppression = evidence.get("silenceSuppression")
        require(isinstance(suppression, dict), "silence suppression missing")
        require(
            suppression.get("speakerOverlapSecondsAfterSuppression") == 0,
            "speaker output covers detected silence",
        )
    else:
        require(fixture.get("id") == gate["resourceFixtureId"], "fixture id")
        require(
            fixture.get("sha256") == gate["resourceFixtureSha256"],
            "resource fixture hash",
        )
        require(
            fixture.get("durationSeconds") == 7200,
            "resource probe did not consume the fixed two-hour input",
        )
        require(evidence.get("oom") is False, "resource probe OOM")
        require(evidence.get("completedFullDuration") is True, "2h incomplete")
        require(
            evidence["configuration"].get("peakRssSampling")
            == contract["benchmarkConfiguration"]["peakRssSampling"],
            "resource peak RSS sampling contract mismatch",
        )
        require(
            evidence.get("metrics", {}).get("incrementalPeakRssBytes")
            <= gate["maxIncrementalPeakRssBytes"],
            "peak RSS gate failed",
        )
    require(evidence.get("metrics", {}).get("rtf") <= gate["maxRtf"], "RTF gate")


def validate(root: Path, contract_path: Path) -> dict[str, str]:
    contract = load(contract_path)
    files = {
        "asr": root / "asr.json",
        "diarization-functional": root / "diarization-functional.json",
        "diarization-resource": root / "diarization-resource.json",
    }
    for path in files.values():
        require(path.is_file(), f"missing evidence: {path}")
    evidence = {name: load(path) for name, path in files.items()}
    validate_asr(evidence["asr"], contract)
    validate_diarization(evidence["diarization-functional"], contract, "diarization-functional")
    validate_diarization(evidence["diarization-resource"], contract, "diarization-resource")
    hashes = {name: sha256(path) for name, path in files.items()}
    index = load(root / "index.json")
    require(index.get("contractId") == contract["contractId"], "index contract")
    require(index.get("evidenceSha256") == hashes, "evidence index hash mismatch")
    return hashes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--evidence-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        hashes = validate(args.evidence_root, args.contract)
    except (EvidenceError, OSError, json.JSONDecodeError, TypeError) as error:
        print(f"desktop evidence invalid: {error}")
        return 1
    print(json.dumps({"status": "PASS", "evidenceSha256": hashes}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
