from __future__ import annotations

import copy
import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path

from aggregate_results import aggregate_candidate
from validate_evidence import (
    EvidenceValidationError,
    canonical_json,
    long_run_repeat_required,
    publish_atomically,
    validate_evidence_tree,
)


SHA = "a" * 64
PROBE_IDS = (
    "crash",
    "timeout",
    "oom",
    "empty_output",
    "malformed_output",
    "malformed_input",
    "short_input",
    "silent_input",
    "deterministic_repeat",
    "term_resistant_cancellation",
    "temporary_cleanup",
    "sandbox_denial",
    "atomic_publication",
)


class EvidenceTree:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.target = {
            "operatingSystem": "macos",
            "operatingSystemVersion": "15.6",
            "architecture": "arm64",
            "cpuModel": "Apple M2",
            "logicalCpuCount": 8,
            "memoryBytes": 16 * 1024**3,
            "runtimeId": "python-fake-contract-smoke",
            "runtimeVersion": "3.14",
            "runtimeSha256": "1" * 64,
        }
        self.target_hash = hashlib.sha256(canonical_json(self.target)).hexdigest()
        self.bindings = {
            "contractSha256": "2" * 64,
            "candidateRegistrySha256": "3" * 64,
            "scoringContractSha256": "4" * 64,
            "runtimeSha256": "1" * 64,
            "workerSha256": "5" * 64,
            "modelComponentsSha256": "6" * 64,
            "profileSha256": "7" * 64,
            "fixtureSha256": "8" * 64,
            "referenceSha256": "9" * 64,
            "targetFingerprintSha256": self.target_hash,
        }
        self.runs = [self._run(index) for index in range(6)]
        aggregate = aggregate_candidate(self.runs)
        aggregate.update(
            {
                "rankEligible": False,
                "observationSource": "fake_worker_contract_smoke",
                "purpose": "orchestrator_scorer_aggregator_vertical_validation",
            }
        )
        self.documents = {
            "runs.json": {
                "schemaVersion": 2,
                "kind": "runSet",
                "evidenceClass": "non_ranked_smoke",
                "rankEligible": False,
                "targetFingerprintSha256": self.target_hash,
                "publicationBindings": self.bindings,
                "runs": self.runs,
            },
            "aggregate.json": {
                "schemaVersion": 2,
                "kind": "aggregate",
                "evidenceClass": "non_ranked_smoke",
                "rankEligible": False,
                "targetFingerprintSha256": self.target_hash,
                "publicationBindings": self.bindings,
                "aggregate": aggregate,
            },
            "reliability.json": {
                "schemaVersion": 2,
                "kind": "reliability",
                "evidenceClass": "non_ranked_smoke",
                "rankEligible": False,
                "targetFingerprintSha256": self.target_hash,
                "publicationBindings": self.bindings,
                "probes": [
                    {
                        "probeId": probe_id,
                        "outcome": "PASS",
                        "disposition": (
                            "TIMEOUT"
                            if probe_id in {"timeout", "term_resistant_cancellation"}
                            else "OOM"
                            if probe_id == "oom"
                            else "CRASH"
                            if probe_id == "crash"
                            else "MALFORMED_OUTPUT"
                            if probe_id == "malformed_output"
                            else "INVALID_INPUT"
                            if probe_id == "malformed_input"
                            else "SUCCESS"
                        ),
                        "details": (
                            {
                                "networkPermissionDenied": True,
                                "userHomePermissionDenied": True,
                            }
                            if probe_id == "sandbox_denial"
                            else {}
                        ),
                    }
                    for probe_id in PROBE_IDS
                ],
                "determinism": {
                    "seed": 20260726,
                    "repeatedRuns": 2,
                    "distinctRawOutputCount": 1,
                    "stable": True,
                },
                "hallucination": {
                    "fixtureId": "generated-silence-1s",
                    "lexicalCharactersPerMinute": 0.0,
                },
                "longRunPolicy": {
                    "executed": False,
                    "repeatWithinLimitFraction": 0.1,
                    "scope": "tooling_only_U7_U8_not_executed",
                },
                "rankedExecutionPrerequisites": [
                    "provision every frozen candidate artifact and approve licenses",
                    "prepare reviewed development and held-out local fixture packs",
                    "freeze profiles and target before any held-out decode",
                ],
            },
        }
        self.write()

    def _run(self, index: int) -> dict:
        return {
            "runId": f"asr2-{index:032x}",
            "complete": True,
            "disposition": "SUCCESS",
            "rankEligible": False,
            "observationSource": "fake_worker_contract_smoke",
            "candidateId": "fake-contract-smoke",
            "laneId": "fake-worker-non-ranked",
            "profileId": "fixed-resource",
            "fixtureId": "committed-zh-300s",
            "scenario": "clean_near_field_mandarin",
            "scorecard": "core_asr",
            "runIndex": index,
            "warmup": index == 0,
            "scheduleOrder": index,
            "bindingSha256": "b" * 64,
            "rawOutputSha256": SHA,
            "metrics": {
                "cer": 0.0,
                "wer": 0.0,
                "terminologyRecall": None,
                "numericEventAccuracy": None,
                "hallucinationLexicalCharactersPerMinute": None,
                "rtf": 0.01,
                "incrementalPeakRssBytes": 1024,
            },
            "resources": {
                "absolutePeakRssBytes": 2048,
                "incrementalPeakRssBytes": 1024,
                "retainedRssBytesAfterUnload": 1024,
                "cpuUserSeconds": 0.1,
                "cpuSystemSeconds": 0.1,
                "temporaryDiskPeakBytes": 0,
            },
            "streamingObservation": {
                "partialCount": 0,
                "firstPartialAudioSeconds": None,
                "firstPartialWallMilliseconds": None,
                "pacingPolicy": "unpaced",
            },
            "temporaryArtifactsReleased": True,
        }

    def write(self) -> None:
        entries = []
        for name, document in self.documents.items():
            path = self.root / name
            path.write_text(
                json.dumps(
                    document,
                    ensure_ascii=False,
                    sort_keys=True,
                    indent=2,
                    allow_nan=True,
                )
                + "\n"
            )
            entries.append(
                {
                    "path": name,
                    "kind": document["kind"],
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "bytes": path.stat().st_size,
                }
            )
        index = {
            "schemaVersion": 2,
            "evidenceSetId": "macos-asr-comparison-v2-smoke",
            "contractId": "desktop-processing/macos-asr-comparison-v2",
            "evidenceClass": "non_ranked_smoke",
            "rankEligible": False,
            "targetFingerprint": self.target,
            "targetFingerprintSha256": self.target_hash,
            "publicationBindings": self.bindings,
            "entries": entries,
        }
        (self.root / "index.json").write_text(
            json.dumps(index, sort_keys=True, indent=2) + "\n"
        )


class ValidateEvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "evidence"
        self.root.mkdir()
        self.tree = EvidenceTree(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def assert_invalid(self) -> None:
        self.tree.write()
        with self.assertRaises(EvidenceValidationError):
            validate_evidence_tree(self.root)

    def test_accepts_complete_bounded_hash_bound_smoke_tree(self) -> None:
        result = validate_evidence_tree(self.root)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["fileCount"], 4)

    def test_rejects_private_payloads_and_paths(self) -> None:
        for key, value in (
            ("transcript", "private words"),
            ("pcm", [1, 2]),
            ("embedding", [0.1]),
            ("voiceprint", "private"),
            ("apiKey", "secret-shaped"),
            ("privateLabel", "person"),
            ("sourcePath", "/Users/someone/private.wav"),
        ):
            with self.subTest(key=key):
                broken = copy.deepcopy(self.tree.documents)
                broken["reliability.json"][key] = value
                self.tree.documents = broken
                self.assert_invalid()
                self.tree = EvidenceTree(self.root)

    def test_rejects_missing_duplicate_or_raw_hash_mismatched_runs(self) -> None:
        aggregate_runs = self.tree.documents["aggregate.json"]["aggregate"]["runs"]
        aggregate_runs.pop()
        self.assert_invalid()
        self.tree = EvidenceTree(self.root)
        self.tree.documents["runs.json"]["runs"][1]["runId"] = (
            self.tree.documents["runs.json"]["runs"][0]["runId"]
        )
        self.assert_invalid()
        self.tree = EvidenceTree(self.root)
        self.tree.documents["aggregate.json"]["aggregate"]["runs"][0][
            "rawOutputSha256"
        ] = "f" * 64
        self.assert_invalid()

    def test_rejects_nonfinite_oversized_and_unknown_disposition(self) -> None:
        self.tree.documents["runs.json"]["runs"][0]["metrics"]["cer"] = math.nan
        self.assert_invalid()
        self.tree = EvidenceTree(self.root)
        self.tree.documents["reliability.json"]["rankedExecutionPrerequisites"][0] = (
            "x" * 2049
        )
        self.assert_invalid()
        self.tree = EvidenceTree(self.root)
        self.tree.documents["reliability.json"]["probes"][0][
            "disposition"
        ] = "UNKNOWN_STAGE_RESULT"
        self.assert_invalid()

    def test_atomic_publication_validates_before_activation(self) -> None:
        publication = Path(self.temporary.name) / "publication"
        result = publish_atomically(self.root, publication)
        self.assertTrue(result["atomicActivation"])
        self.assertTrue((publication / "active").is_symlink())
        self.assertEqual(validate_evidence_tree(publication / "active")["status"], "PASS")
        old_target = (publication / "active").resolve()
        self.tree.documents["reliability.json"]["transcript"] = "private"
        self.tree.write()
        with self.assertRaises(EvidenceValidationError):
            publish_atomically(self.root, publication)
        self.assertEqual((publication / "active").resolve(), old_target)

    def test_long_run_repeat_boundary_is_inclusive_at_ten_percent(self) -> None:
        self.assertTrue(
            long_run_repeat_required({"rtf": 0.455}, {"rtf": 0.5})
        )
        self.assertFalse(
            long_run_repeat_required({"rtf": 0.445}, {"rtf": 0.5})
        )


if __name__ == "__main__":
    unittest.main()
