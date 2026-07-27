from __future__ import annotations

import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from run_qwen3_official_rtf_reproduction import (
    _run_execution_id,
    bootstrap_median_ci,
    diagnostic_segmentation_schedule,
    native_command,
    parse_native_output,
    run_native_once,
    summarize_observations,
    validate_diagnostic_result,
)


class Qwen3OfficialRtfReproductionTest(unittest.TestCase):
    def test_parses_native_emitted_results_without_claiming_detector_latency(
        self,
    ) -> None:
        result = parse_native_output(
            "1.000 -- 3.000: first\n4.000 -- 9.000: second\n",
            (
                "Elapsed seconds: 41.111 s\n"
                "Real time factor (RTF): 41.111 / 334.234 = 0.123\n"
            ),
            external_wall_milliseconds=43_950,
            marker_times={
                "loadStart": 1.0,
                "loadComplete": 2.25,
                "inputStart": 0.5,
                "resultComplete": 43.0,
            },
            resources={
                "absolutePeakRssBytes": 100,
                "incrementalPeakRssBytes": 80,
            },
        )

        self.assertEqual(result["decodeMilliseconds"], 41_111)
        self.assertEqual(result["officialComparableProcessingMilliseconds"], 41_111)
        self.assertEqual(result["cliReportedRtf"], 0.123)
        self.assertAlmostEqual(
            result["officialComparableRtf"],
            41.111 / 334.234,
            places=15,
        )
        self.assertNotEqual(result["officialComparableRtf"], result["cliReportedRtf"])
        self.assertEqual(result["processWallMilliseconds"], 43_950)
        self.assertEqual(result["endToEndWallMilliseconds"], 42_500)
        self.assertEqual(result["emittedResultSegmentCount"], 2)
        self.assertEqual(result["emittedResultSpeechDurationSeconds"], 7)
        self.assertIsNone(result["detectorSegmentCount"])
        self.assertEqual(
            result["metricSupport"]["detectorSegmentCount"]["support"],
            "unsupported",
        )
        self.assertIsNone(result["recognizerDecodeMilliseconds"])

    def test_native_sampler_off_marks_rss_as_unsupported(self) -> None:
        result = parse_native_output(
            "",
            (
                "Elapsed seconds: 41.111 s\n"
                "Real time factor (RTF): 41.111 / 334.234 = 0.123\n"
            ),
            external_wall_milliseconds=43_950,
            marker_times={},
            resources=None,
        )

        self.assertIsNone(result["absolutePeakRssBytes"])
        self.assertEqual(
            result["metricSupport"]["absolutePeakRssBytes"],
            {
                "support": "unsupported",
                "reasonCode": "resource_sampler_disabled",
            },
        )
        self.assertEqual(
            result["metricSupport"]["incrementalPeakRssBytes"],
            {
                "support": "unsupported",
                "reasonCode": "resource_sampler_disabled",
            },
        )

    def test_summary_excludes_warmup_and_keeps_support_reason_explicit(
        self,
    ) -> None:
        unsupported = {
            "support": "unsupported",
            "reasonCode": "test_not_exposed",
        }
        observations = [
            {
                "warmup": True,
                "rtf": 9.0,
                "decodeMilliseconds": 9_000,
            },
            {
                "warmup": False,
                "rtf": 0.2,
                "decodeMilliseconds": 200,
                "outputTokenCount": 20,
                "metricSupport": {
                    key: unsupported
                    for key in (
                        "loadMilliseconds",
                        "cliReportedRtf",
                        "recognizerDecodeMilliseconds",
                        "endToEndWallMilliseconds",
                        "processWallMilliseconds",
                        "officialComparableProcessingMilliseconds",
                        "officialComparableRtf",
                        "segmentLatencyP50Milliseconds",
                        "segmentLatencyP95Milliseconds",
                        "absolutePeakRssBytes",
                        "incrementalPeakRssBytes",
                        "retainedRssBytesAfterUnload",
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
                },
            },
            {
                "warmup": False,
                "rtf": 0.3,
                "decodeMilliseconds": 300,
                "outputTokenCount": 30,
                "metricSupport": {
                    key: unsupported
                    for key in (
                        "loadMilliseconds",
                        "cliReportedRtf",
                        "recognizerDecodeMilliseconds",
                        "endToEndWallMilliseconds",
                        "processWallMilliseconds",
                        "officialComparableProcessingMilliseconds",
                        "officialComparableRtf",
                        "segmentLatencyP50Milliseconds",
                        "segmentLatencyP95Milliseconds",
                        "absolutePeakRssBytes",
                        "incrementalPeakRssBytes",
                        "retainedRssBytesAfterUnload",
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
                },
            },
        ]

        summary = summarize_observations(observations)

        self.assertEqual(summary["warmupRunCount"], 1)
        self.assertEqual(summary["measuredRunCount"], 2)
        self.assertEqual(summary["metrics"]["rtf"]["median"], 0.25)
        self.assertEqual(
            summary["metrics"]["loadMilliseconds"],
            unsupported,
        )

    def test_diagnostic_extension_validation_fails_closed(self) -> None:
        valid = {
            "decodeMilliseconds": 100.0,
            "vadMilliseconds": 1.0,
            "nativeResultFetchMilliseconds": 0.1,
            "ffiStringCopyMilliseconds": 0.1,
            "jsonRepairAndDecodeMilliseconds": 0.1,
            "resultConversionMilliseconds": 0.3,
            "segmentCount": 2,
            "tokens": ["a", "b"],
            "outputTokenCount": 2,
            "segmentWallMilliseconds": [40.0, 60.0],
            "segmentDurationsSeconds": [1.0, 2.0],
            "segmentStartSeconds": [0.0, 2.0],
        }
        validate_diagnostic_result(valid, audio_duration_seconds=4.0)
        for mutation in (
            {"outputTokenCount": 1},
            {"segmentDurationsSeconds": [1.0]},
            {"segmentStartSeconds": [0.0, 3.0], "segmentDurationsSeconds": [1.0, 2.0]},
            {"vadMilliseconds": float("nan")},
        ):
            invalid = {**valid, **mutation}
            with self.subTest(mutation=mutation), self.assertRaises(Exception):
                validate_diagnostic_result(invalid, audio_duration_seconds=4.0)

    def test_native_timeout_reaps_group_and_writes_bounded_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory)
            started = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                run_native_once(
                    command=[
                        "/bin/sh",
                        "-c",
                        "trap '' TERM; sleep 30 & wait",
                    ],
                    output_root=output_root,
                    lane_id="timeout-test",
                    run_index=0,
                    warmup=False,
                    sampler_interval_seconds=None,
                    execution_id="a" * 32,
                    timeout_seconds=0.05,
                )
            self.assertLess(time.monotonic() - started, 5)
            failure = json.loads(
                (
                    output_root
                    / "failures/timeout-test-measured-0.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(failure["outcome"], "FAILED")
            self.assertEqual(failure["failureCode"], "TIMEOUT")
            self.assertRegex(failure["executionId"], r"^[0-9a-f]{32}$")

    def test_execution_identity_changes_per_lane_and_run(self) -> None:
        first = _run_execution_id("a" * 32, "lane-a", 0, True)
        second = _run_execution_id("a" * 32, "lane-a", 1, False)
        self.assertNotEqual(first, second)
        self.assertRegex(first, r"^[0-9a-f]{32}$")

    def test_diagnostic_segmentation_schedule_is_equal_and_interleaved(
        self,
    ) -> None:
        schedule = diagnostic_segmentation_schedule("fixed", "vad")
        self.assertEqual(schedule["warmupOrder"], ["fixed", "vad"])
        self.assertEqual(
            schedule["measuredOrder"],
            ["fixed", "vad"] * 5,
        )
        self.assertEqual(schedule["measuredOrder"].count("fixed"), 5)
        self.assertEqual(schedule["measuredOrder"].count("vad"), 5)

    def test_bootstrap_ci_is_deterministic(self) -> None:
        self.assertEqual(
            bootstrap_median_ci([1.0, 2.0, 3.0, 4.0, 5.0]),
            bootstrap_median_ci([1.0, 2.0, 3.0, 4.0, 5.0]),
        )

    def test_native_command_pins_official_controls_and_page_era_default(
        self,
    ) -> None:
        command = native_command(
            executable=Path("/runtime/cli"),
            model_root=Path("/model"),
            silero_model=Path("/model/silero.onnx"),
            audio=Path("/audio/Obama.wav"),
            threads=2,
        )
        for expected in (
            "--num-threads=2",
            "--provider=cpu",
            "--qwen3-asr-max-total-len=512",
            "--qwen3-asr-max-new-tokens=512",
            "--qwen3-asr-temperature=0.000001",
            "--qwen3-asr-top-p=0.8",
            "--qwen3-asr-seed=42",
            "--qwen3-asr-hotwords=",
            "--silero-vad-threshold=0.2",
            "--silero-vad-min-speech-duration=0.2",
            "--silero-vad-max-speech-duration=20",
        ):
            self.assertIn(expected, command)
        page_era = native_command(
            executable=Path("/runtime/cli"),
            model_root=Path("/model"),
            silero_model=Path("/model/silero.onnx"),
            audio=Path("/audio/Obama.wav"),
            threads=2,
            supports_hotwords=False,
        )
        self.assertNotIn("--qwen3-asr-hotwords=", page_era)


if __name__ == "__main__":
    unittest.main()
