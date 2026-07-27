from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path

from build_m4_qwen3_official_rtf_reproduction_report import (
    COMPARISON_ROOT,
    EXPECTED_LANES,
    PublicationError,
    _reject_sensitive_payload_keys,
    _privacy_validate,
    _ratio,
    _validate_metric_states,
    _validate_raw_evidence,
    build_report,
    publish_pair,
    validate_bounded,
    verify_published_pair,
)
from run_macos_asr_comparison import sha256_bytes, sha256_file
from run_qwen3_official_rtf_reproduction import summarize_observations


def measured(value: float) -> dict[str, object]:
    return {
        "support": "measured",
        "count": 5,
        "median": value,
        "p95": value,
        "minimum": value,
        "maximum": value,
        "median95PercentBootstrapCI": [value, value],
    }


def summary(rtf: float) -> dict[str, object]:
    return {
        "warmupRunCount": 1,
        "measuredRunCount": 5,
        "warmupObservations": [],
        "observations": [
            {"runIndex": index, "officialComparableRtf": rtf}
            for index in range(1, 6)
        ],
        "metrics": {
            "officialComparableRtf": measured(rtf),
            "rtf": measured(rtf),
            "decodeMilliseconds": measured(rtf * 334_234.5),
            "endToEndWallMilliseconds": measured(rtf * 334_234.5 + 1000),
            "processWallMilliseconds": measured(rtf * 334_234.5 + 1200),
            "absolutePeakRssBytes": measured(1024**3),
            "resultConversionMilliseconds": measured(0.5),
        },
    }


def bounded_fixture() -> dict[str, object]:
    lane_values = {
        "native-v1.12.34-ort1.23.2-page-era": 0.13,
        "native-v1.13.4-ort1.24.4-diagnostic": 0.105,
        "native-v1.13.4-ort1.27.0-current": 0.22,
        "dart-v1.13.4-ort1.27.0-fixed15-current-worker": 0.21,
        "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker": 0.211,
        "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker": 0.212,
    }
    return {
        "schemaVersion": 2,
        "kind": "m4_qwen3_official_rtf_reproduction_local_bounded_evidence",
        "outcome": "COMPLETED",
        "execution": {
            "executionId": "a" * 32,
            "startedAt": "2026-07-27T00:00:00Z",
            "completedAt": "2026-07-27T01:00:00Z",
            "freshRunRequired": True,
            "resumedRunCount": 0,
        },
        "runnerSha256": "b" * 64,
        "host": {"cpu": "Apple M4"},
        "officialBaseline": {
            "pageUrl": "https://example.com/page",
            "audioUrl": "https://example.com/Obama.wav",
            "audioDurationSeconds": 334.234,
            "elapsedSeconds": 34.480,
            "rtf": 0.103,
        },
        "strictControls": {},
        "audio": {"sha256": "c" * 64},
        "provenance": {
            "modelHashes": {},
            "sileroVadSha256": "d" * 64,
        },
        "lanes": {lane: summary(value) for lane, value in lane_values.items()},
        "diagnosticSegmentationSchedule": {
            "design": "alternating_after_equal_lane_warmups",
            "warmupOrder": [
                "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker",
                "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker",
            ],
            "measuredOrder": [
                lane
                for _ in range(5)
                for lane in (
                    "dart-v1.13.4-ort1.27.0-fixed15-diagnostic-worker",
                    "dart-v1.13.4-ort1.27.0-official-silero-diagnostic-worker",
                )
            ],
            "scheduleOrderStart": 0,
        },
        "diagnosticProbes": {
            "samplerOffCurrentOrt127": summary(0.219),
            "threadScalingCurrentOrt127": [],
        },
    }


class Qwen3OfficialRtfReportTest(unittest.TestCase):
    def test_ratio_preserves_runtime_slowdown(self) -> None:
        self.assertAlmostEqual(_ratio(0.257, 0.125), 2.056)

    def test_perturbed_evidence_changes_computed_conclusions(self) -> None:
        bounded = bounded_fixture()
        report = build_report(
            bounded,
            {},
            {"developmentResults": {"zh": {"medianRtf": 0.2}, "en": {"medianRtf": 0.2}}},
            bounded_summary_sha256="e" * 64,
            builder_sha256="f" * 64,
        )
        self.assertTrue(
            report["assessment"]["sameMachineReproducedOfficialWithinTolerance"]
        )
        self.assertTrue(report["assessment"]["runtimeRegressionThresholdMet"])
        self.assertAlmostEqual(
            report["comparisons"][
                "diagnosticVadVsDiagnosticFixed15ProcessingRtfRatio"
            ],
            0.212 / 0.211,
        )
        self.assertEqual(
            report["comparisons"]["diagnosticSegmentationComparisonMethod"],
            "median_of_five_interleaved_same_run_index_pair_ratios",
        )

        perturbed = copy.deepcopy(bounded)
        perturbed["lanes"][
            "native-v1.13.4-ort1.24.4-diagnostic"
        ] = summary(0.20)
        perturbed["lanes"][
            "native-v1.13.4-ort1.27.0-current"
        ] = summary(0.22)
        perturbed_report = build_report(
            perturbed,
            {},
            {"developmentResults": {"zh": {"medianRtf": 0.2}, "en": {"medianRtf": 0.2}}},
            bounded_summary_sha256="1" * 64,
            builder_sha256="f" * 64,
        )
        self.assertFalse(
            perturbed_report["assessment"][
                "sameMachineReproducedOfficialWithinTolerance"
            ]
        )
        self.assertFalse(
            perturbed_report["assessment"]["runtimeRegressionThresholdMet"]
        )

    def test_incomplete_bounded_evidence_fails_before_local_hash_checks(self) -> None:
        incomplete = bounded_fixture()
        incomplete["lanes"].pop(next(iter(EXPECTED_LANES)))
        with self.assertRaises(PublicationError):
            validate_bounded(
                incomplete,
                repository_root=Path("/does/not/matter"),
                bounded_path=Path("/does/not/matter/bounded_summary.json"),
                experiment={},
            )

    def test_metric_summary_is_recomputed_and_semantic_change_fails(self) -> None:
        metric_names = (
            "loadMilliseconds",
            "decodeMilliseconds",
            "recognizerDecodeMilliseconds",
            "endToEndWallMilliseconds",
            "processWallMilliseconds",
            "officialComparableProcessingMilliseconds",
            "officialComparableRtf",
            "cliReportedRtf",
            "rtf",
            "segmentLatencyP50Milliseconds",
            "segmentLatencyP95Milliseconds",
            "absolutePeakRssBytes",
            "incrementalPeakRssBytes",
            "retainedRssBytesAfterUnload",
            "outputTokenCount",
            "tokensPerAudioSecond",
            "nativeResultFetchMilliseconds",
            "ffiStringCopyMilliseconds",
            "jsonRepairAndDecodeMilliseconds",
            "resultConversionMilliseconds",
            "vadMilliseconds",
            "detectorSegmentCount",
            "emittedResultSegmentCount",
            "emittedResultSpeechDurationSeconds",
        )
        observations = [
            {
                "warmup": warmup,
                **{
                    name: float(index + metric_index + 1)
                    for metric_index, name in enumerate(metric_names)
                },
            }
            for index, warmup in ((0, True), (1, False), (2, False))
        ]
        summary_value = summarize_observations(observations)
        _validate_metric_states(summary_value, "synthetic")
        changed = copy.deepcopy(summary_value)
        changed["metrics"]["rtf"]["median"] += 0.01
        with self.assertRaises(PublicationError):
            _validate_metric_states(changed, "synthetic")

    def test_sensitive_payload_key_is_rejected(self) -> None:
        for key in ("text", "tokens", "transcript", "hypothesis", "reference"):
            with self.subTest(key=key), self.assertRaises(PublicationError):
                _reject_sensitive_payload_keys({key: "private"}, "test")

    def test_native_raw_binding_recomputes_full_precision_rtf(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            lane_id = "native-v1.13.4-ort1.27.0-current"
            raw_root = local_root / "evidence" / lane_id / "raw"
            raw_root.mkdir(parents=True)
            stdout_path = raw_root / "run.stdout.log"
            stderr_path = raw_root / "run.stderr.log"
            stdout_path.write_text("", encoding="utf-8")
            stderr_path.write_text(
                "Elapsed seconds: 41.111 s\n"
                "Real time factor (RTF): 41.111 / 334.234 = 0.123\n",
                encoding="utf-8",
            )
            observation = {
                "laneId": lane_id,
                "decodeMilliseconds": 41_111.0,
                "cliReportedRtf": 0.123,
                "officialComparableRtf": 41.111 / 334.234,
                "rtf": 41.111 / 334.234,
                "emittedResultSegmentCount": 0,
                "emittedResultSpeechDurationSeconds": 0.0,
            }
            observation_record_path = raw_root / "run.observation.json"
            observation_record_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "kind": "m4_qwen3_native_observation_binding",
                        "observation": observation,
                    }
                ),
                encoding="utf-8",
            )
            observation["rawEvidence"] = {
                "kind": "native_cli_logs",
                "stdoutRelativePath": "raw/run.stdout.log",
                "stdoutSha256": sha256_file(stdout_path),
                "stderrRelativePath": "raw/run.stderr.log",
                "stderrSha256": sha256_file(stderr_path),
                "observationRecordRelativePath": "raw/run.observation.json",
                "observationRecordSha256": sha256_file(
                    observation_record_path
                ),
            }
            _validate_raw_evidence(observation, local_root=local_root)
            observation["officialComparableRtf"] = 0.123
            with self.assertRaises(PublicationError):
                _validate_raw_evidence(observation, local_root=local_root)

    def test_native_thread_probe_is_bound_to_raw_cli_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            lane_id = "native-current-threads-4"
            raw_root = local_root / "evidence/thread-probes/raw"
            raw_root.mkdir(parents=True)
            stdout_path = raw_root / "run.stdout.log"
            stderr_path = raw_root / "run.stderr.log"
            stdout_path.write_text("", encoding="utf-8")
            stderr_path.write_text(
                "--num-threads=4 \n"
                "num threads: 4\n"
                "Elapsed seconds: 41.111 s\n"
                "Real time factor (RTF): 41.111 / 334.234 = 0.123\n",
                encoding="utf-8",
            )
            bound = {
                "laneId": lane_id,
                "decodeMilliseconds": 41_111.0,
                "cliReportedRtf": 0.123,
                "officialComparableRtf": 41.111 / 334.234,
                "rtf": 41.111 / 334.234,
                "emittedResultSegmentCount": 0,
                "emittedResultSpeechDurationSeconds": 0.0,
            }
            observation_record_path = raw_root / "run.observation.json"
            observation_record_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "kind": "m4_qwen3_native_observation_binding",
                        "observation": bound,
                    }
                ),
                encoding="utf-8",
            )
            observation = {
                **bound,
                "threads": 4,
                "rawEvidence": {
                    "kind": "native_cli_logs",
                    "stdoutRelativePath": "raw/run.stdout.log",
                    "stdoutSha256": sha256_file(stdout_path),
                    "stderrRelativePath": "raw/run.stderr.log",
                    "stderrSha256": sha256_file(stderr_path),
                    "observationRecordRelativePath": "raw/run.observation.json",
                    "observationRecordSha256": sha256_file(
                        observation_record_path
                    ),
                },
            }
            _validate_raw_evidence(observation, local_root=local_root)
            observation["threads"] = 6
            with self.assertRaises(PublicationError):
                _validate_raw_evidence(observation, local_root=local_root)

    def test_dart_raw_binding_rejects_run_record_metric_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            lane_id = "dart-v1.13.4-ort1.27.0-fixed15-current-worker"
            evidence_root = local_root / "evidence" / lane_id
            (evidence_root / "runs").mkdir(parents=True)
            (evidence_root / "raw").mkdir()
            run_id = "asr2-" + "a" * 32
            raw = {
                "runId": run_id,
                "events": [
                    {
                        "type": "result",
                        "text": "local-only",
                        "tokens": ["local"],
                        "timestamps": [],
                        "durationSeconds": 10.0,
                        "segmentCount": 1,
                        "segmentDurationsSeconds": None,
                    }
                ],
            }
            semantic_hash = sha256_bytes(
                json.dumps(
                    {
                        "text": "local-only",
                        "tokens": ["local"],
                        "timestamps": [],
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode()
            )
            run = {
                "runId": run_id,
                "complete": True,
                "disposition": "SUCCESS",
                "resumed": False,
                "laneId": lane_id,
                "runIndex": 1,
                "warmup": False,
                "scheduleOrder": 1,
                "rawOutputSha256": semantic_hash,
                "metrics": {
                    "rtf": 0.2,
                    "decodeMilliseconds": 2_000.0,
                },
            }
            run_path = evidence_root / "runs" / f"{run_id}.json"
            raw_path = evidence_root / "raw" / f"{run_id}.json"
            run_path.write_text(json.dumps(run), encoding="utf-8")
            raw_path.write_text(json.dumps(raw), encoding="utf-8")
            observation = {
                "laneId": lane_id,
                "runIndex": 1,
                "warmup": False,
                "scheduleOrder": 1,
                "rtf": 0.2,
                "recognizerDecodeMilliseconds": 2_000.0,
                "officialComparableProcessingMilliseconds": 2_000.0,
                "officialComparableRtf": 0.2,
                "outputTokenCount": 1,
                "tokensPerAudioSecond": 0.1,
                "segmentCount": 1,
                "segmentDurationsSeconds": None,
                "vadMilliseconds": None,
                "nativeResultFetchMilliseconds": None,
                "ffiStringCopyMilliseconds": None,
                "jsonRepairAndDecodeMilliseconds": None,
                "resultConversionMilliseconds": None,
                "rawOutputSha256": semantic_hash,
                "rawEvidence": {
                    "kind": "dart_execute_run",
                    "runId": run_id,
                    "runRecordRelativePath": f"runs/{run_id}.json",
                    "runRecordSha256": sha256_file(run_path),
                    "rawRecordRelativePath": f"raw/{run_id}.json",
                    "rawRecordSha256": sha256_file(raw_path),
                },
            }
            _validate_raw_evidence(observation, local_root=local_root)
            observation["rtf"] = 0.3
            with self.assertRaises(PublicationError):
                _validate_raw_evidence(observation, local_root=local_root)

    def test_privacy_rejects_posix_and_windows_paths_but_allows_urls(self) -> None:
        declaration = {
            "audioPublished": False,
            "modelFilesPublished": False,
            "transcriptPublished": False,
            "referenceTextPublished": False,
            "absolutePathsPublished": False,
            "rawLogsLocalOnly": True,
        }
        _privacy_validate(
            {"source": "https://example.com/a/b", "privacy": declaration},
            "https://example.com/c/d",
        )
        for path in (
            "/Users/private/audio.wav",
            "/home/runner/audio.wav",
            "/workspace/build/audio.wav",
            r"C:\Users\private\audio.wav",
            r"\\server\share\audio.wav",
        ):
            with self.subTest(path=path), self.assertRaises(PublicationError):
                _privacy_validate(
                    {"path": path, "privacy": declaration},
                    "",
                )

    def test_checked_in_report_pair_is_privacy_safe(self) -> None:
        report_path = COMPARISON_ROOT / "m4_qwen3_official_rtf_reproduction.json"
        markdown_path = (
            COMPARISON_ROOT / "M4_QWEN3_OFFICIAL_RTF_REPRODUCTION_REPORT.md"
        )
        if not report_path.exists() or not markdown_path.exists():
            self.skipTest("report pair has not been generated")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        markdown = markdown_path.read_text(encoding="utf-8")
        _privacy_validate(report, markdown)

    def test_published_pair_verification_rejects_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            json_path = root / "report.json"
            markdown_path = root / "report.md"
            json_path.write_text(
                json.dumps(
                    {
                        "publicationId": "abc",
                        "boundedSummarySha256": "d" * 64,
                        "privacy": {
                            "audioPublished": False,
                            "modelFilesPublished": False,
                            "transcriptPublished": False,
                            "referenceTextPublished": False,
                            "absolutePathsPublished": False,
                            "rawLogsLocalOnly": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            markdown_path.write_text(
                "Publication ID: `different`\n"
                f"Bounded evidence SHA-256: `{'d' * 64}`\n",
                encoding="utf-8",
            )
            with self.assertRaises(PublicationError):
                verify_published_pair(json_path, markdown_path)

    def test_published_pair_binds_complete_markdown_and_detects_edit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            json_path = root / "report.json"
            markdown_path = root / "report.md"
            markdown = (
                "Publication ID: `abc`\n"
                f"Bounded evidence SHA-256: `{'d' * 64}`\n"
            )
            report = {
                "publicationId": "abc",
                "boundedSummarySha256": "d" * 64,
                "markdownSha256": sha256_bytes(markdown.encode()),
                "privacy": {
                    "audioPublished": False,
                    "modelFilesPublished": False,
                    "transcriptPublished": False,
                    "referenceTextPublished": False,
                    "absolutePathsPublished": False,
                    "rawLogsLocalOnly": True,
                },
            }
            publish_pair(
                report,
                markdown,
                json_path=json_path,
                markdown_path=markdown_path,
            )
            verify_published_pair(json_path, markdown_path)
            markdown_path.write_text(markdown + "semantic change\n", encoding="utf-8")
            with self.assertRaises(PublicationError):
                verify_published_pair(json_path, markdown_path)

    def test_pair_publish_rolls_back_both_files_on_second_replace_failure(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            json_path = root / "report.json"
            markdown_path = root / "report.md"
            json_path.write_bytes(b"old-json")
            markdown_path.write_bytes(b"old-markdown")
            markdown = (
                "Publication ID: `abc`\n"
                f"Bounded evidence SHA-256: `{'d' * 64}`\n"
            )
            report = {
                "publicationId": "abc",
                "boundedSummarySha256": "d" * 64,
                "markdownSha256": sha256_bytes(markdown.encode()),
                "privacy": {
                    "audioPublished": False,
                    "modelFilesPublished": False,
                    "transcriptPublished": False,
                    "referenceTextPublished": False,
                    "absolutePathsPublished": False,
                    "rawLogsLocalOnly": True,
                },
            }
            calls = 0

            def fail_second(source: Path, destination: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected second replace failure")
                os.replace(source, destination)

            with self.assertRaises(OSError):
                publish_pair(
                    report,
                    markdown,
                    json_path=json_path,
                    markdown_path=markdown_path,
                    replace_fn=fail_second,
                )
            self.assertEqual(json_path.read_bytes(), b"old-json")
            self.assertEqual(markdown_path.read_bytes(), b"old-markdown")


if __name__ == "__main__":
    unittest.main()
