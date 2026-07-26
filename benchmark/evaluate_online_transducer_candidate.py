#!/usr/bin/env python3
"""Evaluate physical-device online-transducer capability evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

try:
    from benchmark.desktop.asr_comparison.asr_scoring import (
        alignment_labels as shared_alignment,
        lexical_characters,
    )
except ModuleNotFoundError:
    from desktop.asr_comparison.asr_scoring import (
        alignment_labels as shared_alignment,
        lexical_characters,
    )


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmark" / "audio" / "online_transducer_candidate_manifest.json"
DEFAULT_AUDIO_ROOT = ROOT / "benchmark" / "audio"
DEFAULT_REGISTRY = ROOT / "benchmark" / "asr_model_candidates.json"
REQUIRED_RUN_IDS = {"baseline", "hotword_score_1_5"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--audio-root", type=Path, default=DEFAULT_AUDIO_ROOT)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize(text: str) -> str:
    return "".join(lexical_characters(text))


def alignment(reference: str, hypothesis: str) -> tuple[int, list[bool]]:
    return shared_alignment(reference, hypothesis)


def expected_calibration_error(
    probabilities: list[float],
    labels: list[bool],
    bin_count: int = 10,
) -> float:
    if len(probabilities) != len(labels) or not probabilities:
        raise ValueError("calibration inputs must be non-empty and have equal length")
    total = len(probabilities)
    error = 0.0
    for index in range(bin_count):
        lower = index / bin_count
        upper = (index + 1) / bin_count
        members = [
            position
            for position, probability in enumerate(probabilities)
            if lower <= probability < upper or (index == bin_count - 1 and probability == 1.0)
        ]
        if not members:
            continue
        confidence = sum(probabilities[position] for position in members) / len(members)
        accuracy = sum(1.0 for position in members if labels[position]) / len(members)
        error += (len(members) / total) * abs(accuracy - confidence)
    return error


def roc_auc(probabilities: list[float], labels: list[bool]) -> float | None:
    positives = [value for value, label in zip(probabilities, labels) if label]
    negatives = [value for value, label in zip(probabilities, labels) if not label]
    if not positives or not negatives:
        return None
    favorable = 0.0
    for positive in positives:
        for negative in negatives:
            favorable += 1.0 if positive > negative else 0.5 if positive == negative else 0.0
    return favorable / (len(positives) * len(negatives))


def validate_evidence_identity(
    manifest: dict[str, Any],
    registry: dict[str, Any],
    evidence: dict[str, Any],
) -> None:
    candidate_id = manifest.get("candidateId")
    matches = [
        candidate
        for candidate in registry.get("candidates", [])
        if candidate.get("id") == candidate_id
    ]
    if len(matches) != 1:
        raise ValueError("candidateId does not resolve exactly once in the registry")
    artifact = matches[0].get("artifact", {})
    expected_hashes = artifact.get("requiredFileSha256", {})
    observed_hashes = evidence.get("modelFiles", {})
    for key in ("encoder", "decoder", "joiner", "tokens"):
        if observed_hashes.get(f"{key}Sha256") != expected_hashes.get(key):
            raise ValueError(f"physical evidence {key} hash mismatch")
    decoder = manifest["decoder"]
    if evidence.get("decoderMethod") != decoder["method"]:
        raise ValueError("decoder method mismatch")
    if int(evidence.get("maxActivePaths", -1)) != int(decoder["maxActivePaths"]):
        raise ValueError("decoder maxActivePaths mismatch")
    if not math.isclose(
        float(evidence.get("hotwordsScore", math.nan)),
        float(decoder["hotwordsScore"]),
        rel_tol=0.0,
        abs_tol=1e-9,
    ):
        raise ValueError("decoder hotwordsScore mismatch")


def index_runs(evidence: dict[str, Any]) -> dict[str, dict[str, Any]]:
    runs = evidence.get("runs")
    if not isinstance(runs, list):
        raise ValueError("physical evidence runs must be a list")
    indexed: dict[str, dict[str, Any]] = {}
    for run in runs:
        if not isinstance(run, dict):
            raise ValueError("every physical evidence run must be an object")
        run_id = str(run.get("id", ""))
        if run_id in indexed:
            raise ValueError(f"duplicate physical evidence run id: {run_id}")
        indexed[run_id] = run
    if set(indexed) != REQUIRED_RUN_IDS:
        raise ValueError(
            "physical evidence run ids must be exactly "
            f"{sorted(REQUIRED_RUN_IDS)}"
        )
    return indexed


def evaluate_run(
    run: dict[str, Any],
    reference: str,
    target_phrases: list[str],
) -> dict[str, Any]:
    hypothesis = normalize(str(run["text"]))
    tokens = [str(token) for token in run.get("tokens", [])]
    timestamps = [float(value) for value in run.get("timestamps", [])]
    scores = [float(value) for value in run.get("ysProbs", [])]
    if not tokens or len(tokens) != len(timestamps) or len(tokens) != len(scores):
        raise ValueError(f"{run.get('id')}: token/timestamp/ysProbs counts differ")
    if normalize("".join(tokens)) != hypothesis:
        raise ValueError(f"{run.get('id')}: tokens do not reconstruct the hypothesis")
    if any(not math.isfinite(score) for score in scores):
        raise ValueError(f"{run.get('id')}: ysProbs contains a non-finite value")
    if any(current < previous for previous, current in zip(timestamps, timestamps[1:])):
        raise ValueError(f"{run.get('id')}: timestamps are not monotonic")

    distance, labels = alignment(reference, hypothesis)
    probabilities = [math.exp(score) for score in scores]
    if any(probability < 0.0 or probability > 1.0 for probability in probabilities):
        raise ValueError(f"{run.get('id')}: exp(ysProbs) is outside [0, 1]")
    brier = sum(
        (probability - (1.0 if label else 0.0)) ** 2
        for probability, label in zip(probabilities, labels)
    ) / len(probabilities)
    return {
        "id": str(run["id"]),
        "hotwordsEnabled": bool(run["hotwordsEnabled"]),
        "cer": distance / max(1, len(reference)),
        "editDistance": distance,
        "referenceCharacters": len(reference),
        "hypothesisCharacters": len(hypothesis),
        "rtf": float(run["rtf"]),
        "loadMs": int(run["loadMs"]),
        "decodeWallMs": int(run["decodeWallMs"]),
        "peakSampledJavaHeapBytes": int(run["peakSampledJavaHeapBytes"]),
        "peakSampledNativeHeapBytes": int(run["peakSampledNativeHeapBytes"]),
        "targetPhraseHits": {
            phrase: hypothesis.count(phrase) for phrase in target_phrases
        },
        "scoreScreening": {
            "signal": "exp(ysProbs)",
            "coverage": len(scores) / max(1, len(tokens)),
            "labeledOutputCharacters": len(labels),
            "incorrectOutputCharacters": sum(not label for label in labels),
            "brier": brier,
            "ece10": expected_calibration_error(probabilities, labels),
            "rocAuc": roc_auc(probabilities, labels),
            "minimumRawScore": min(scores),
            "maximumRawScore": max(scores),
        },
    }


def evaluate(
    manifest: dict[str, Any],
    registry: dict[str, Any],
    evidence: dict[str, Any],
    audio_root: Path,
) -> dict[str, Any]:
    if manifest.get("schemaVersion") != 1 or evidence.get("schemaVersion") != 1:
        raise ValueError("manifest and physical evidence schemaVersion must be 1")
    if evidence.get("source") != "physical_android_instrumentation":
        raise ValueError("candidate evidence must come from physical_android_instrumentation")
    if evidence.get("candidateId") != manifest.get("candidateId"):
        raise ValueError("candidateId does not match the manifest")
    required_device_classes = set(
        manifest.get("gatePolicy", {}).get("requiredDeviceClasses", [])
    )
    if evidence.get("deviceSerialClass") not in required_device_classes:
        raise ValueError("physical evidence device class is not preregistered")
    validate_evidence_identity(manifest, registry, evidence)
    corpus = manifest["corpus"]
    audio = audio_root / str(corpus["audio"])
    reference_file = audio_root / str(corpus["reference"])
    hotwords_file = audio_root / str(manifest["decoder"]["hotwordsFile"])
    for path in (audio, reference_file, hotwords_file):
        if not path.is_file():
            raise ValueError(f"missing candidate fixture: {path}")
    if sha256(audio) != corpus["audioSha256"]:
        raise ValueError("candidate audio hash mismatch")
    if sha256(reference_file) != corpus["referenceSha256"]:
        raise ValueError("candidate reference hash mismatch")
    if evidence.get("audioSha256") != corpus["audioSha256"]:
        raise ValueError("physical evidence audio hash mismatch")
    if sha256(hotwords_file) != manifest["decoder"]["hotwordsFileSha256"]:
        raise ValueError("hotwords file hash mismatch")
    if evidence.get("hotwordsFileSha256") != manifest["decoder"]["hotwordsFileSha256"]:
        raise ValueError("physical evidence hotwords hash mismatch")
    reference = normalize(reference_file.read_text(encoding="utf-8"))
    target_phrases = [normalize(value) for value in corpus["targetPhrases"]]
    run_by_id = index_runs(evidence)
    baseline = evaluate_run(run_by_id["baseline"], reference, target_phrases)
    hotword = evaluate_run(run_by_id["hotword_score_1_5"], reference, target_phrases)
    expected_hits = {phrase: reference.count(phrase) for phrase in target_phrases}
    baseline_hit_total = sum(baseline["targetPhraseHits"].values())
    hotword_hit_total = sum(hotword["targetPhraseHits"].values())
    target_improved = hotword_hit_total > baseline_hit_total
    global_cer_regressed = hotword["cer"] > baseline["cer"]
    return {
        "schemaVersion": 1,
        "candidateId": evidence["candidateId"],
        "source": evidence["source"],
        "deviceClass": evidence.get("deviceSerialClass"),
        "device": {
            "manufacturer": evidence.get("manufacturer"),
            "model": evidence.get("model"),
            "sdkInt": evidence.get("sdkInt"),
        },
        "referenceTargetPhraseHits": expected_hits,
        "runs": [baseline, hotword],
        "hotwordGate": {
            "decoderEffectMeasured": baseline["editDistance"] != hotword["editDistance"]
            or run_by_id["baseline"]["text"] != run_by_id["hotword_score_1_5"]["text"],
            "baselineTargetHitTotal": baseline_hit_total,
            "hotwordTargetHitTotal": hotword_hit_total,
            "targetHitRateImproved": target_improved,
            "globalCerRegressed": global_cer_regressed,
            "passed": target_improved and not global_cer_regressed,
        },
        "confidenceGate": {
            "rawScoreSignalObserved": True,
            "screeningOnly": True,
            "heldOutCalibrationEvidencePresent": False,
            "passed": False,
            "reason": "independently_labeled_calibration_and_held_out_validation_missing",
        },
        "releaseEligible": False,
        "releaseBlockers": [
            "hotword_target_hit_rate_not_improved"
            if not target_improved
            else "hotword_gate_requires_full_regression_matrix",
            "confidence_independent_calibration_missing",
            "low_device_evidence_missing",
            "production_integration_not_admitted",
        ],
    }


def main() -> int:
    args = parse_args()
    try:
        report = evaluate(
            load_json(args.manifest),
            load_json(args.registry),
            load_json(args.evidence),
            args.audio_root,
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Online candidate evaluation blocked: {error}")
        return 1
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    print(payload)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
