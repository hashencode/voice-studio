from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from native_funasr_adapter import adapt_native_result
from run_macos_asr_comparison import (
    OrchestrationError,
    _minimal_environment,
    _validate_event,
    build_stage_plan,
    deterministic_run_id,
    deterministic_schedule,
    execute_run,
)


ROOT = Path(__file__).resolve().parent
FAKE = ROOT / "test_support/fake_candidate_worker.py"
SHA = "a" * 64


def binding(**changes: str) -> dict[str, str]:
    value = {
        "contractSha256": SHA,
        "candidateRegistrySha256": "b" * 64,
        "scoringContractSha256": "c" * 64,
        "scorerSha256": "a" * 64,
        "runtimeSha256": "d" * 64,
        "workerSha256": "e" * 64,
        "fixtureSha256": "f" * 64,
        "referenceSha256": "1" * 64,
        "profileSha256": "2" * 64,
    }
    value.update(changes)
    return value


def matrix_item(candidate: str = "fake-a") -> dict:
    return {
        "candidateId": candidate,
        "profileId": "fixed-resource",
        "fixtureId": "fixture-a",
        "laneId": "fake-lane",
        "scorecard": "core_asr",
        "scenario": "clean_near_field_mandarin",
        "reference": "测试一二三",
        "rankEligible": False,
        "observationSource": "fake_worker_contract_smoke",
    }


def request(candidate: str = "fake-a") -> dict:
    return {
        "candidateId": candidate,
        "profileId": "fixed-resource",
        "sourceSha256": "f" * 64,
        "durationSeconds": 1.0,
        "hypothesis": "测试一二三",
        "memoryBytes": 24 * 1024 * 1024,
        "effectiveConfig": {
            "modelFamily": "fake",
            "provider": "cpu",
            "numThreads": 2,
        },
        "capabilities": {
            "streaming": False,
            "timestamps": False,
            "partialResults": False,
        },
    }


class ScheduleTest(unittest.TestCase):
    def test_launcher_environment_exposes_home_only_for_active_denial_probe(
        self,
    ) -> None:
        environment = _minimal_environment(Path("/tmp/comparison"))
        self.assertEqual(environment["HOME"], os.environ["HOME"])
        self.assertTrue(Path(environment["HOME"]).is_absolute())

    def test_handshake_must_precede_runtime_initialization(self) -> None:
        with self.assertRaisesRegex(
            OrchestrationError, "before the baseline freeze"
        ):
            _validate_event(
                {
                    "schemaVersion": 2,
                    "type": "handshake",
                    "candidateId": "fake-a",
                    "profileId": "fixed-resource",
                    "sourceSha256": "f" * 64,
                    "processId": 123,
                    "runtimeBindingState": "initialized",
                },
                specification={
                    **matrix_item(),
                    "sourceSha256": "f" * 64,
                },
                observed_types=[],
            )

    def test_handshake_requires_positive_process_identity(self) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            _validate_event(
                {
                    "schemaVersion": 2,
                    "type": "handshake",
                    "candidateId": "fake-a",
                    "profileId": "fixed-resource",
                    "sourceSha256": "f" * 64,
                    "processId": 0,
                    "runtimeBindingState": "not_initialized",
                },
                specification={
                    **matrix_item(),
                    "sourceSha256": "f" * 64,
                },
                observed_types=[],
            )
        self.assertEqual(caught.exception.code, "MALFORMED_OUTPUT")

    def test_result_token_and_timestamp_counts_are_bounded(self) -> None:
        with self.assertRaisesRegex(OrchestrationError, "observation bounds"):
            _validate_event(
                {
                    "schemaVersion": 2,
                    "type": "result",
                    "candidateId": "fake-a",
                    "profileId": "fixed-resource",
                    "sourceSha256": "f" * 64,
                    "text": "bounded",
                    "tokens": [""] * 100_001,
                    "timestamps": [],
                    "durationSeconds": 1,
                    "loadMilliseconds": 1,
                    "decodeMilliseconds": 1,
                },
                specification={
                    **matrix_item(),
                    "sourceSha256": "f" * 64,
                },
                observed_types=[
                    "handshake",
                    "effectiveConfig",
                    "modelLoadComplete",
                ],
            )

    def test_unload_complete_requires_worker_resident_bytes(self) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            _validate_event(
                {
                    "schemaVersion": 2,
                    "type": "unloadComplete",
                    "candidateId": "fake-a",
                },
                specification={
                    **matrix_item(),
                    "sourceSha256": "f" * 64,
                },
                observed_types=[
                    "handshake",
                    "effectiveConfig",
                    "modelLoadComplete",
                    "result",
                    "unloadStart",
                ],
            )
        self.assertEqual(caught.exception.code, "MALFORMED_OUTPUT")

    def test_typed_worker_error_preserves_candidate_identity(self) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            _validate_event(
                {
                    "schemaVersion": 2,
                    "type": "error",
                    "candidateId": "fake-a",
                    "profileId": "fixed-resource",
                    "sourceSha256": "f" * 64,
                    "code": "DECODE_FAILED",
                    "message": "StateError",
                },
                specification={
                    **matrix_item(),
                    "sourceSha256": "f" * 64,
                },
                observed_types=[
                    "handshake",
                    "effectiveConfig",
                    "modelLoadComplete",
                ],
            )
        self.assertEqual(caught.exception.code, "DECODE_FAILED")

    def test_two_candidate_short_schedule_rotates_and_is_deterministic(self) -> None:
        matrix = [matrix_item("fake-a"), matrix_item("fake-b")]
        first = deterministic_schedule(
            matrix, seed=20260726, warmup_runs=1, measured_runs=5
        )
        second = deterministic_schedule(
            list(reversed(matrix)), seed=20260726, warmup_runs=1, measured_runs=5
        )
        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)
        self.assertEqual(sum(item["warmup"] for item in first), 2)
        for candidate in ("fake-a", "fake-b"):
            candidate_runs = [
                item for item in first if item["candidateId"] == candidate
            ]
            self.assertEqual(len(candidate_runs), 6)
            self.assertEqual(sum(not item["warmup"] for item in candidate_runs), 5)
        round_orders = [
            tuple(
                item["candidateId"]
                for item in first
                if item["runIndex"] == run_index
            )
            for run_index in range(6)
        ]
        self.assertGreater(len(set(round_orders)), 1)

    def test_stage_plan_preserves_frozen_candidates_and_u7_u8_boundary(
        self,
    ) -> None:
        contract = json.loads((ROOT / "macos_contract.json").read_text())
        registry = json.loads((ROOT / "candidates.json").read_text())
        fixtures = json.loads((ROOT / "fixtures.json").read_text())
        short = build_stage_plan(
            contract,
            registry,
            fixtures,
            stage_id="STAGE_1_SHORT",
        )
        self.assertTrue(short["planOnly"])
        self.assertFalse(short["executionAuthorized"])
        self.assertEqual(
            {entry["candidateId"] for entry in short["matrixEntries"]},
            set(registry["frozenCandidateSet"]),
        )
        held_out = build_stage_plan(
            contract,
            registry,
            fixtures,
            stage_id="STAGE_2_HELD_OUT",
        )
        self.assertNotIn(
            "native-funasr-1.3.22-paraformer-vad-punctuation",
            {entry["candidateId"] for entry in held_out["matrixEntries"]},
        )
        self.assertIn(
            "U7_U8_EXECUTION_NOT_AUTHORIZED_BY_U1_U6_TOOLING",
            held_out["executionBlockers"],
        )


class ExecuteRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.run_root = self.root / "runs"
        self.raw_root = self.root / "raw"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def execute(
        self,
        *,
        mode: str = "success",
        item: dict | None = None,
        run_binding: dict[str, str] | None = None,
        timeout: float = 3,
    ) -> dict:
        specification = {
            **(item or matrix_item()),
            "sourceSha256": "f" * 64,
            "runIndex": 0,
            "warmup": False,
            "scheduleOrder": 0,
        }
        worker_request = request(specification["candidateId"])
        if specification.get("pacingPolicy") == "realtime_audio_clock":
            worker_request["capabilities"]["streaming"] = True
            worker_request["capabilities"]["partialResults"] = True
        return execute_run(
            command=[sys.executable, str(FAKE), "--mode", mode],
            request=worker_request,
            specification=specification,
            binding=run_binding or binding(),
            run_root=self.run_root,
            raw_root=self.raw_root,
            timeout_seconds=timeout,
            sampler_interval_seconds=0.01,
        )

    def test_success_is_scored_atomic_and_resumable_without_transcript(self) -> None:
        first = self.execute()
        second = self.execute()
        self.assertTrue(first["complete"])
        self.assertEqual(first["metrics"]["cer"], 0)
        self.assertGreaterEqual(first["metrics"]["incrementalPeakRssBytes"], 0)
        self.assertGreater(first["metrics"]["endToEndWallMilliseconds"], 0)
        self.assertEqual(first["metrics"]["segmentLatencyP50Milliseconds"], 2)
        self.assertEqual(first["metrics"]["segmentLatencyP95Milliseconds"], 2)
        self.assertEqual(
            first["streamingObservation"]["applicability"], "not_applicable"
        )
        self.assertEqual(
            first["streamingObservation"]["firstPartialStatus"], "unsupported"
        )
        self.assertEqual(
            first["streamingObservation"]["firstFinalStatus"], "unsupported"
        )
        self.assertTrue(first["temporaryArtifactsReleased"])
        self.assertFalse(first["rankEligible"])
        self.assertTrue(second["resumed"])
        published = json.loads(
            (self.run_root / f"{first['runId']}.json").read_text()
        )
        self.assertNotIn("text", json.dumps(published))
        self.assertTrue((self.raw_root / f"{first['runId']}.json").is_file())

    def test_streaming_keeps_audio_clock_observation_separate_from_rtf(self) -> None:
        item = {
            **matrix_item(),
            "pacingPolicy": "realtime_audio_clock",
        }
        result = self.execute(mode="streaming", item=item)
        self.assertEqual(result["streamingObservation"]["partialCount"], 1)
        self.assertEqual(
            result["streamingObservation"]["firstPartialAudioSeconds"], 0.5
        )
        self.assertEqual(
            result["streamingObservation"]["firstPartialWallMilliseconds"], 500
        )
        self.assertEqual(result["metrics"]["rtf"], 0.002)
        self.assertEqual(result["metrics"]["liveElapsedMilliseconds"], 1000)
        self.assertEqual(result["streamingObservation"]["finalAudioSeconds"], 1)
        self.assertEqual(
            result["streamingObservation"]["finalWallMilliseconds"], 1000
        )
        self.assertEqual(
            result["streamingObservation"]["firstFinalWallMilliseconds"], 1000
        )
        self.assertEqual(
            result["streamingObservation"]["endpointLatencyMilliseconds"], 0
        )
        self.assertEqual(
            result["streamingObservation"]["tailLatencyMilliseconds"], 0
        )
        self.assertEqual(
            result["streamingObservation"]["applicability"], "supported"
        )
        self.assertEqual(
            result["streamingObservation"]["firstPartialStatus"], "observed"
        )
        self.assertEqual(
            result["streamingObservation"]["firstFinalStatus"], "observed"
        )
        self.assertEqual(result["streamingObservation"]["droppedChunkCount"], 0)
        self.assertEqual(
            result["streamingObservation"]["maximumQueuedChunkCount"], 1
        )

    def test_binding_change_cannot_reuse_prior_run_identity(self) -> None:
        first = self.execute()
        changed = self.execute(
            run_binding=binding(workerSha256="3" * 64)
        )
        self.assertNotEqual(first["runId"], changed["runId"])
        self.assertFalse(changed["resumed"])

    def test_tampered_run_or_raw_output_is_quarantined_and_rerun(self) -> None:
        first = self.execute()
        published_path = self.run_root / f"{first['runId']}.json"
        published = json.loads(published_path.read_text())
        published["metrics"]["cer"] = 0.75
        published_path.write_text(json.dumps(published))
        rerun = self.execute()
        self.assertFalse(rerun["resumed"])
        self.assertEqual(rerun["metrics"]["cer"], 0)
        self.assertEqual(
            len(list((self.run_root / "quarantine").iterdir())), 1
        )
        raw_path = self.raw_root / f"{first['runId']}.json"
        raw = json.loads(raw_path.read_text())
        next(
            event for event in raw["events"] if event["type"] == "result"
        )["text"] = "tampered"
        raw_path.write_text(json.dumps(raw))
        rerun_again = self.execute()
        self.assertFalse(rerun_again["resumed"])
        self.assertEqual(rerun_again["metrics"]["cer"], 0)

    def test_partial_staging_is_quarantined_before_rerun(self) -> None:
        specification = {
            **matrix_item(),
            "sourceSha256": "f" * 64,
            "runIndex": 0,
            "warmup": False,
            "scheduleOrder": 0,
        }
        run_id = deterministic_run_id(specification, binding())
        staging = self.run_root / ".staging" / f"{run_id}.json"
        staging.parent.mkdir(parents=True)
        staging.write_text('{"complete":false}\n')
        result = self.execute()
        self.assertTrue(result["complete"])
        quarantined = list((self.run_root / "quarantine").iterdir())
        self.assertEqual(len(quarantined), 1)
        self.assertIn(".partial.", quarantined[0].name)

    def test_timeout_kills_term_resistant_process_group_and_no_run_publishes(
        self,
    ) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            self.execute(mode="term_resistant", timeout=0.15)
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertEqual(list(self.run_root.glob("asr2-*.json")), [])
        disposition = json.loads(
            next((self.run_root / ".staging").iterdir()).read_text()
        )
        self.assertTrue(disposition["termination"]["termSent"])
        self.assertTrue(disposition["termination"]["killSent"])
        self.assertTrue(disposition["termination"]["processGroupGone"])
        self.assertGreaterEqual(
            disposition["termination"]["observedDescendantCount"], 1
        )
        self.assertTrue(
            disposition["termination"]["descendantProcessesGone"]
        )
        self.assertTrue(disposition["temporaryArtifactsReleased"])

    def test_malformed_output_is_typed_and_not_aggregatable(self) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            self.execute(mode="malformed")
        self.assertEqual(caught.exception.code, "MALFORMED_OUTPUT")
        self.assertEqual(list(self.run_root.glob("asr2-*.json")), [])


class NativeAdapterTest(unittest.TestCase):
    def test_native_control_uses_separate_non_ranked_lane(self) -> None:
        envelope = adapt_native_result(
            {"metrics": {"cer": 0.1, "rtf": 0.2}},
            stage_id="STAGE_1_SHORT",
            candidate_id="native-funasr",
            fixture_id="fixture-a",
            profile_id="recommended",
        )
        self.assertFalse(envelope["rankEligible"])
        self.assertTrue(envelope["crossRuntimeControl"])
        self.assertNotIn("sherpa", envelope["laneId"])

    def test_native_control_is_rejected_after_short_stage(self) -> None:
        with self.assertRaises(OrchestrationError) as caught:
            adapt_native_result(
                {"metrics": {}},
                stage_id="STAGE_2_HELD_OUT",
                candidate_id="native-funasr",
                fixture_id="fixture-a",
                profile_id="recommended",
            )
        self.assertEqual(caught.exception.code, "NATIVE_STAGE_FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
