from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from aggregate_results import aggregate_candidate, compare_to_baseline
from development_freeze import (
    DevelopmentFreezeError,
    build_development_freeze,
    publish_development_freeze,
    validate_development_freeze,
)


SOURCE_ROOT = Path(__file__).resolve().parent


class DevelopmentFreezeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.comparison = self.root / "benchmark/desktop/asr_comparison"
        self.comparison.mkdir(parents=True)
        self.contract = json.loads(
            (SOURCE_ROOT / "macos_contract.json").read_text()
        )
        self.contract["contractState"] = (
            "M4_DEVELOPMENT_FROZEN_HELD_OUT_SEALED"
        )
        self.contract["materialBenefitRule"]["state"] = "FROZEN"
        self.registry = json.loads(
            (SOURCE_ROOT / "candidates.json").read_text()
        )
        self.scoring = json.loads(
            (SOURCE_ROOT / "scoring_contract.json").read_text()
        )
        self.fixtures = self._frozen_fixtures()
        self._write_json("macos_contract.json", self.contract)
        self._write_json("candidates.json", self.registry)
        self._write_json("fixtures.json", self.fixtures)
        self._write_json("scoring_contract.json", self.scoring)
        (self.comparison / "asr_scoring.py").write_bytes(
            (SOURCE_ROOT / "asr_scoring.py").read_bytes()
        )
        self.matrix_root = (
            self.root / "build/desktop_asr_comparison/development/m4"
        )
        self._write_matrix()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_builds_bounded_freeze_and_validates_sealed_transition(self) -> None:
        freeze = build_development_freeze(
            self.root,
            self.matrix_root,
            frozen_at="2026-07-26T16:00:00Z",
        )

        self.assertTrue(freeze["heldOutAuthorized"])
        self.assertFalse(freeze["heldOutDecoded"])
        self.assertFalse(freeze["rankEligible"])
        self.assertEqual(len(freeze["aggregateSha256"]), 8)
        self.assertEqual(len(freeze["comparisons"]), 6)
        self.assertEqual(freeze["targetFingerprint"]["cpuModel"], "Apple M4")
        self.assertEqual(
            freeze["materialBenefitRule"]["state"],
            "FROZEN",
        )
        native = next(
            item
            for item in freeze["excludedCandidateDispositions"]
            if item["candidateId"].startswith("native-funasr")
        )
        self.assertEqual(
            native["terminalDisposition"],
            "CROSS_RUNTIME_CONTROL_COMPLETE",
        )
        self.assertEqual(
            validate_development_freeze(
                freeze,
                self.root,
                self.matrix_root,
            ),
            freeze,
        )
        published = json.dumps(freeze, ensure_ascii=False)
        self.assertNotIn('"transcript"', published.lower())
        self.assertNotIn(str(self.root), published)

    def test_rejects_unfrozen_materiality_contract(self) -> None:
        contract = copy.deepcopy(self.contract)
        contract["contractState"] = (
            "M4_STAGE_0_ADMITTED_DEVELOPMENT_ASSETS_REQUIRED"
        )
        contract["materialBenefitRule"]["state"] = "PROPOSED_UNFROZEN"
        self._write_json("macos_contract.json", contract)

        with self.assertRaisesRegex(
            DevelopmentFreezeError,
            "contract is not sealed",
        ):
            build_development_freeze(
                self.root,
                self.matrix_root,
                frozen_at="2026-07-26T16:00:00Z",
            )

    def test_rejects_any_held_out_decode_claim(self) -> None:
        result_path = self.matrix_root / "development-matrix-result.json"
        result = json.loads(result_path.read_text())
        result["heldOutDecoded"] = True
        self._write_path_json(result_path, result)

        with self.assertRaisesRegex(
            DevelopmentFreezeError,
            "held-out data was decoded",
        ):
            build_development_freeze(
                self.root,
                self.matrix_root,
                frozen_at="2026-07-26T16:00:00Z",
            )

    def test_rejects_aggregate_or_comparison_drift(self) -> None:
        aggregate_path = next(
            (self.matrix_root / "aggregates").rglob("*.json")
        )
        aggregate = json.loads(aggregate_path.read_text())
        aggregate["macroMetrics"]["cer"] = 0.99
        self._write_path_json(aggregate_path, aggregate)

        with self.assertRaisesRegex(
            DevelopmentFreezeError,
            "aggregate drift",
        ):
            build_development_freeze(
                self.root,
                self.matrix_root,
                frozen_at="2026-07-26T16:00:00Z",
            )

    def test_rejects_published_comparison_drift(self) -> None:
        result_path = self.matrix_root / "development-matrix-result.json"
        result = json.loads(result_path.read_text())
        comparison = next(iter(result["comparisons"].values()))
        comparison["paretoEligible"] = not comparison["paretoEligible"]
        self._write_path_json(result_path, result)

        with self.assertRaisesRegex(
            DevelopmentFreezeError,
            "comparison drift",
        ):
            build_development_freeze(
                self.root,
                self.matrix_root,
                frozen_at="2026-07-26T16:00:00Z",
            )

    def test_publish_is_atomic_and_revalidates_existing_document(self) -> None:
        output = (
            self.root
            / "benchmark/desktop/evidence/macos-asr-comparison-v2/"
            "development-freeze.json"
        )
        freeze = publish_development_freeze(
            self.root,
            self.matrix_root,
            output,
            frozen_at="2026-07-26T16:00:00Z",
        )
        self.assertEqual(json.loads(output.read_text()), freeze)

        validate_development_freeze(
            json.loads(output.read_text()),
            self.root,
            self.matrix_root,
        )
        result_path = self.matrix_root / "development-matrix-result.json"
        result = json.loads(result_path.read_text())
        result["complete"] = False
        self._write_path_json(result_path, result)
        with self.assertRaises(DevelopmentFreezeError):
            publish_development_freeze(
                self.root,
                self.matrix_root,
                output,
                frozen_at="2026-07-26T17:00:00Z",
            )
        self.assertEqual(json.loads(output.read_text()), freeze)

    def _write_matrix(self) -> None:
        candidates = [
            candidate
            for candidate in self.registry["candidates"]
            if candidate["runtimeKind"] == "sherpa_onnx"
            and candidate["admission"]["status"] == "ADMITTED"
        ]
        development = [
            fixture
            for fixture in self.fixtures["fixtures"]
            if fixture["fixtureRole"] == "development"
        ]
        aggregates = {}
        aggregate_paths = {}
        schedule_order = 0
        for candidate_index, candidate in enumerate(candidates):
            for profile_id in self.contract["profiles"][
                "requiredSherpaProfiles"
            ]:
                runs = []
                for fixture in development:
                    for run_index in range(6):
                        warmup = run_index == 0
                        runs.append(
                            {
                                "runId": (
                                    f"{candidate_index}-{profile_id}-"
                                    f"{fixture['fixtureId']}-{run_index}"
                                ),
                                "complete": True,
                                "disposition": "SUCCESS",
                                "candidateId": candidate["candidateId"],
                                "laneId": candidate["runtimeLaneIds"][0],
                                "profileId": profile_id,
                                "fixtureId": fixture["fixtureId"],
                                "scenario": fixture["scenario"],
                                "scorecard": candidate["profiles"][
                                    profile_id
                                ]["scorecard"],
                                "runIndex": run_index,
                                "warmup": warmup,
                                "scheduleOrder": schedule_order,
                                "rawOutputSha256": hashlib.sha256(
                                    (
                                        candidate["candidateId"]
                                        + profile_id
                                    ).encode()
                                ).hexdigest(),
                                "metrics": {
                                    "cer": 0.2 - candidate_index * 0.02,
                                    "wer": 0.2,
                                    "terminologyRecall": 0.8,
                                    "numericEventAccuracy": 0.8,
                                    "hallucinationLexicalCharactersPerMinute": 0.0,
                                    "rtf": 0.1,
                                    "loadMilliseconds": 100.0,
                                    "decodeMilliseconds": 1000.0,
                                    "absolutePeakRssBytes": 200,
                                    "incrementalPeakRssBytes": 100,
                                    "retainedRssBytesAfterUnload": 50,
                                },
                            }
                        )
                        schedule_order += 1
                aggregate = aggregate_candidate(runs)
                key = f"{candidate['candidateId']}/{profile_id}"
                path = (
                    self.matrix_root
                    / "aggregates"
                    / candidate["candidateId"]
                    / f"{profile_id}.json"
                )
                self._write_path_json(path, aggregate)
                aggregates[key] = aggregate
                aggregate_paths[key] = str(path.relative_to(self.root))
        comparisons = {}
        baseline_id = self.contract["baselineCandidateId"]
        for profile_id in self.contract["profiles"][
            "requiredSherpaProfiles"
        ]:
            baseline = aggregates[f"{baseline_id}/{profile_id}"]
            for candidate in candidates:
                if candidate["candidateId"] == baseline_id:
                    continue
                key = f"{candidate['candidateId']}/{profile_id}"
                comparisons[key] = compare_to_baseline(
                    aggregates[key],
                    baseline,
                    hard_gates=self.contract["hardGates"],
                    materiality=self.contract["materialBenefitRule"],
                )
        result = {
            "schemaVersion": 2,
            "kind": "development_matrix_result",
            "complete": True,
            "rankEligible": False,
            "heldOutDecoded": False,
            "targetFingerprint": {
                "operatingSystemVersion": "15.7.5",
                "architecture": "arm64",
                "cpuModel": "Apple M4",
                "logicalCpuCount": 10,
                "memoryBytes": 17179869184,
                "runtimeId": self.contract["runtimeLanes"][0]["laneId"],
                "runtimeVersion": self.contract["runtimeLanes"][0][
                    "runtime"
                ]["version"],
                "runtimeSha256": "e" * 64,
            },
            "contractSha256": self._sha("macos_contract.json"),
            "candidateRegistrySha256": self._sha("candidates.json"),
            "fixtureManifestSha256": self._sha("fixtures.json"),
            "scoringContractSha256": self._sha("scoring_contract.json"),
            "scorerSha256": self._sha("asr_scoring.py"),
            "workerSha256": "f" * 64,
            "scheduledRunCount": 192,
            "completedRunCount": 192,
            "warmupRunCount": 32,
            "measuredRunCount": 160,
            "aggregatePaths": aggregate_paths,
            "comparisons": comparisons,
            "materialityState": "FROZEN",
            "developmentFreezeReady": True,
        }
        self._write_path_json(
            self.matrix_root / "development-matrix-result.json",
            result,
        )

    def _frozen_fixtures(self) -> dict:
        fixtures = json.loads((SOURCE_ROOT / "fixtures.json").read_text())
        for fixture in fixtures["fixtures"]:
            if fixture["fixtureRole"] != "development":
                continue
            fixture["licenseOrConsent"] = (
                "SIGNED_CONSENT_REVIEWED_FOR_LOCAL_BENCHMARK"
                if fixture["sourceKind"] == "consented_internal_recording"
                else "REVIEWED_FOR_LOCAL_BENCHMARK"
            )
            fixture["referenceReview"] = "REVIEWED"
            if fixture["scenario"] == "dialect_accent":
                fixture["varietyReview"] = "REVIEWED"
            fixture["freezeState"] = "FROZEN"
            fixture["audio"].update(
                {
                    "sha256": hashlib.sha256(
                        f"{fixture['fixtureId']}:audio".encode()
                    ).hexdigest(),
                    "bytes": 32044,
                    "durationSeconds": 1.0,
                }
            )
            fixture["reference"].update(
                {
                    "sha256": hashlib.sha256(
                        f"{fixture['fixtureId']}:reference".encode()
                    ).hexdigest(),
                    "bytes": 12,
                }
            )
        return fixtures

    def _write_json(self, name: str, value: dict) -> None:
        self._write_path_json(self.comparison / name, value)

    @staticmethod
    def _write_path_json(path: Path, value: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                value,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )

    def _sha(self, name: str) -> str:
        return hashlib.sha256((self.comparison / name).read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
