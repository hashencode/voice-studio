from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from benchmark.evaluate_speaker_diarization import evaluate_final_diagnostic
from benchmark.speaker_diarization_contract import (
    ManifestError,
    validate_final_diagnostic_contract,
    validate_final_diagnostic_evidence,
    validate_final_diagnostic_repository,
)


def _model(model_id: str, sha256: str) -> dict:
    return {
        "id": model_id,
        "sha256": sha256,
        "bytes": 1,
        "license": "Apache-2.0",
        "licenseReviewed": True,
    }


def _arm(
    arm_id: str,
    *,
    threads: int,
    embedding: dict,
) -> dict:
    return {
        "id": arm_id,
        "mode": "OFFICIAL_PARITY",
        "status": "FAIL",
        "numThreads": threads,
        "directFullFixtureProcess": True,
        "usesWindowing": False,
        "usesExternalEmbedding": False,
        "usesReconciliation": False,
        "segmentation": _model("pyannote-segmentation-3.0", "1" * 64),
        "embedding": embedding,
        "clustering": {
            "algorithm": "fast_clustering",
            "numSpeakers": 2,
            "threshold": 0.5,
        },
        "minDurationOn": 0.3,
        "minDurationOff": 0.5,
        "evidencePath": f"benchmark/evidence/{arm_id}.json",
        "evidenceSha256": "9" * 64,
        "evaluationPath": f"benchmark/evidence/{arm_id}-evaluation.json",
        "evaluationSha256": "8" * 64,
    }


def _contract() -> dict:
    three_d = _model("3dspeaker-eres2net", "2" * 64)
    titanet = _model("nemo-titanet-small", "3" * 64)
    return {
        "schemaVersion": 1,
        "contractId": "speaker-diarization-final-diagnostic/v1",
        "target": {
            "platform": "android",
            "manufacturer": "Xiaomi",
            "model": "M2102J2SC",
            "minimumSdkInt": 33,
        },
        "fixture": {
            "wavSha256": "4" * 64,
            "rttmSha256": "5" * 64,
            "sampleRate": 16000,
            "durationSeconds": 300,
        },
        "thresholds": {
            "minimumAnnotatedSpeechCoverage": 0.8,
            "maximumDer": 0.3,
            "maximumRtf": 0.5,
            "requiresOverlapRepresentation": True,
            "requiresNoSpeakerInPreregisteredSilence": True,
            "requiresTranscriptSnapshotHashMatch": True,
            "requiresCompleteInputConsumption": True,
        },
        "controlArm": {
            "id": "product-integration-control",
            "status": "FAIL",
            "frozenWindowSamples": 480000,
            "frozenOverlapSamples": 80000,
            "frozenReconciliationThreshold": 0.8,
        },
        "parityArms": [
            _arm("official-3dspeaker-t1", threads=1, embedding=three_d),
            _arm("official-3dspeaker-t2", threads=2, embedding=three_d),
            _arm("official-3dspeaker-t4", threads=4, embedding=three_d),
            _arm("official-titanet-t2", threads=2, embedding=titanet),
        ],
        "terminalDisposition": "MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE",
        "nextCandidate": None,
    }


def _evidence(arm: dict) -> dict:
    return {
        "schemaVersion": 1,
        "source": "physical_android_instrumentation",
        "contractId": "speaker-diarization-final-diagnostic/v1",
        "armId": arm["id"],
        "complete": True,
        "device": {
            "manufacturer": "Xiaomi",
            "model": "M2102J2SC",
            "sdkInt": 33,
            "buildFingerprint": "fixture",
            "maximumThermalStatusRaw": 0,
            "maximumThermalStatusName": "none",
        },
        "fixture": {
            "sha256": "4" * 64,
            "sha256After": "4" * 64,
            "sampleRate": 16000,
            "totalSamples": 4_800_000,
            "consumedSamples": 4_800_000,
        },
        "configuration": {
            "mode": "OFFICIAL_PARITY",
            "numThreads": arm["numThreads"],
            "directFullFixtureProcess": True,
            "usesWindowing": False,
            "usesExternalEmbedding": False,
            "usesReconciliation": False,
            "segmentationSha256": arm["segmentation"]["sha256"],
            "embeddingSha256": arm["embedding"]["sha256"],
            "clusteringAlgorithm": "fast_clustering",
            "numSpeakers": 2,
            "clusteringThreshold": 0.5,
            "minDurationOn": 0.3,
            "minDurationOff": 0.5,
        },
        "transcriptSnapshot": {
            "beforeSha256": "6" * 64,
            "afterSha256": "6" * 64,
        },
        "timings": {
            "elapsedMs": 3_000_000,
            "rtf": 10.0,
        },
        "resources": {
            "baselinePssKiB": 1,
            "peakPssKiB": 2,
            "peakJavaBytes": 3,
            "peakNativeBytes": 4,
        },
        "turns": [
            {"startSeconds": 0.0, "endSeconds": 20.0, "speakerIndex": 0},
            {"startSeconds": 20.0, "endSeconds": 40.0, "speakerIndex": 1},
        ],
    }


class SpeakerDiarizationFinalDiagnosticTest(unittest.TestCase):
    def test_repository_final_diagnostic_is_terminal_and_hash_bound(self) -> None:
        contract = json.loads(
            Path(
                "benchmark/speaker_diarization_final_diagnostic_contract.json"
            ).read_text(encoding="utf-8")
        )

        result = validate_final_diagnostic_repository(contract, Path.cwd())

        self.assertEqual(
            "MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE",
            result["terminalDisposition"],
        )
        self.assertEqual(4, result["armCount"])

    def test_repository_shape_is_terminal_and_has_no_candidate_loop(self) -> None:
        validate_final_diagnostic_contract(_contract())

    def test_contract_rejects_multi_variable_parity_arm(self) -> None:
        contract = _contract()
        arm = contract["parityArms"][2]
        arm["usesWindowing"] = True
        arm["clustering"]["threshold"] = 0.7

        with self.assertRaisesRegex(ManifestError, "official parity"):
            validate_final_diagnostic_contract(contract)

    def test_official_parity_evidence_rejects_windowing_or_reconciliation(self) -> None:
        contract = _contract()
        arm = contract["parityArms"][0]
        evidence = _evidence(arm)
        evidence["configuration"]["usesReconciliation"] = True

        with self.assertRaisesRegex(ManifestError, "official parity"):
            validate_final_diagnostic_evidence(evidence, arm, contract)

    def test_titanet_requires_segmentation_and_clustering_identity(self) -> None:
        contract = _contract()
        titanet = contract["parityArms"][-1]
        del titanet["segmentation"]

        with self.assertRaisesRegex(ManifestError, "segmentation"):
            validate_final_diagnostic_contract(contract)

    def test_semantic_or_resource_failure_closes_arm(self) -> None:
        contract = _contract()
        arm = contract["parityArms"][0]
        evidence = _evidence(arm)
        result = evaluate_final_diagnostic(
            evidence,
            arm,
            contract,
            rttm_text=(
                "SPEAKER fixture 1 0.000 10.000 <NA> <NA> speaker_1 <NA> <NA>\n"
                "SPEAKER fixture 1 10.000 10.000 <NA> <NA> speaker_2 <NA> <NA>"
            ),
            overlap_regions=[[5.0, 6.0]],
            silence_regions=[[30.0, 35.0]],
        )

        self.assertEqual("FAIL", result["status"])
        self.assertIn("OVERLAP", result["failedGates"])
        self.assertIn("SILENCE", result["failedGates"])
        self.assertIn("RTF", result["failedGates"])

    def test_terminal_contract_rejects_in_progress_or_next_candidate(self) -> None:
        for mutation in ("status", "nextCandidate"):
            with self.subTest(mutation=mutation):
                contract = copy.deepcopy(_contract())
                if mutation == "status":
                    contract["parityArms"][0]["status"] = "IN_PROGRESS"
                else:
                    contract["nextCandidate"] = "third-candidate"

                with self.assertRaisesRegex(ManifestError, "terminal|candidate"):
                    validate_final_diagnostic_contract(contract)


if __name__ == "__main__":
    unittest.main()
