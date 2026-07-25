from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from benchmark.evaluate_s2_enhancement import (
    evaluate,
    paired_boundary_p95,
    percentile_nearest_rank,
    transcript_metrics,
)


class EvaluateS2EnhancementTest(unittest.TestCase):
    def test_nearest_rank_percentile(self) -> None:
        self.assertEqual(percentile_nearest_rank([1, 2, 3, 4], 0.95), 4)

    def test_paired_boundary_delta(self) -> None:
        raw = {
            "segments": [
                {"startMs": 100, "endMs": 500},
                {"startMs": 900, "endMs": 1300},
            ]
        }
        enhanced = {
            "segments": [
                {"startMs": 120, "endMs": 480},
                {"startMs": 940, "endMs": 1310},
            ]
        }
        self.assertEqual(paired_boundary_p95(raw, enhanced), 40)

    def test_unmatched_segment_count_is_not_comparable(self) -> None:
        self.assertIsNone(
            paired_boundary_p95(
                {"segments": [{"startMs": 0, "endMs": 1}]},
                {"segments": []},
            )
        )

    def test_invalid_transcript_segment_order_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "segments must be contiguous and ordered",
        ):
            transcript_metrics(
                {
                    "status": "ok",
                    "text": "abc",
                    "rtf": 0.1,
                    "transcriptionMs": 1,
                    "segments": [
                        {"sequenceId": 0, "startMs": 100, "endMs": 200},
                        {"sequenceId": 1, "startMs": 150, "endMs": 250},
                    ],
                },
                "abc",
            )

    def test_complete_evidence_is_thresholded_but_never_release_eligible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "audio.wav"
            reference = root / "reference.txt"
            audio.write_bytes(b"fixed audio")
            reference.write_text("abc", encoding="utf-8")
            model_hash = "a" * 64
            case_ids = (
                "quiet_clean",
                "steady_noise_5db",
                "burst_noise_0db",
                "near_talk",
                "far_talk_5db",
            )
            manifest = {
                "schemaVersion": 1,
                "model": {"sha256": model_hash},
                "recognitionModel": {
                    "id": "model",
                    "modelSha256": "b" * 64,
                    "tokensSha256": "c" * 64,
                },
                "source": {
                    "audio": "audio.wav",
                    "reference": "reference.txt",
                    "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "referenceSha256": hashlib.sha256(
                        reference.read_bytes()
                    ).hexdigest(),
                },
                "cases": [
                    {
                        "id": case_id,
                        "kind": case_id,
                        "noiseSnrDb": 5 if "noise" in case_id or "far" in case_id else None,
                    }
                    for case_id in case_ids
                ],
                "preregisteredGates": {
                    "quietCerAbsoluteRegressionMax": 0.005,
                    "noiseMeanCerAbsoluteImprovementMin": 0.05,
                    "perNoiseCaseCerAbsoluteRegressionMax": 0.02,
                    "enhancementRtfMax": 0.25,
                    "combinedPipelineRtfMax": 1.0,
                    "peakJavaHeapDeltaBytesMax": 100,
                    "peakNativeHeapDeltaBytesMax": 100,
                    "timestampP95DeltaMsMax": 250,
                },
            }
            generated_cases = []
            evidence_cases = []
            for case_id in case_ids:
                fixture = root / f"{case_id}.wav"
                fixture.write_bytes(case_id.encode())
                fixture_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
                generated_cases.append(
                    {"id": case_id, "path": str(fixture), "sha256": fixture_hash}
                )
                is_noise = "noise" in case_id or "far" in case_id
                raw_text = "" if is_noise else "abc"
                result = {
                    "status": "ok",
                    "transcriptionMs": 1,
                    "rtf": 0.1,
                    "text": raw_text,
                    "segments": [{"sequenceId": 0, "startMs": 0, "endMs": 100}],
                }
                enhanced = dict(result)
                enhanced["text"] = "abc"
                enhanced["segments"] = list(result["segments"])
                evidence_cases.append(
                    {
                        "id": case_id,
                        "inputSha256": fixture_hash,
                        "sourcePreserved": True,
                        "raw": result,
                        "enhanced": enhanced,
                        "enhancementRtf": 0.1,
                        "combinedEnhancedRtf": 0.2,
                        "javaHeapBeforeBytes": 100,
                        "nativeHeapBeforeBytes": 100,
                        "peakSampledJavaHeapBytes": 150,
                        "peakSampledNativeHeapBytes": 150,
                    }
                )
            evidence = {
                "schemaVersion": 1,
                "source": "physical_android_instrumentation",
                "complete": True,
                "enhancementModelSha256": model_hash,
                "deviceClass": "mid",
                "manufacturer": "test",
                "model": "test",
                "sdkInt": 33,
                "deviceStateBefore": {"thermalStatus": 0},
                "deviceStateAfter": {"thermalStatus": 0},
                "cases": evidence_cases,
            }
            evidence_hash = "d" * 64
            identity = {
                "schemaVersion": 1,
                "source": "physical_android_instrumentation",
                "manufacturer": "test",
                "model": "test",
                "sdkInt": 33,
                "pairedReportSha256": evidence_hash,
                "recognitionModelId": "model",
                "recognitionModelSha256": "b" * 64,
                "recognitionTokensSha256": "c" * 64,
                "enhancementModelSha256": model_hash,
            }

            report = evaluate(
                manifest,
                {"schemaVersion": 1, "cases": generated_cases},
                evidence,
                identity,
                evidence_hash,
                root=root,
            )

            self.assertTrue(report["midDeviceTechnicalGatesPassed"])
            self.assertFalse(report["releaseEligible"])
            self.assertFalse(report["productGatePassed"])

            identity["model"] = "other-device"
            with self.assertRaisesRegex(
                ValueError,
                "identity model does not match paired evidence",
            ):
                evaluate(
                    manifest,
                    {"schemaVersion": 1, "cases": generated_cases},
                    evidence,
                    identity,
                    evidence_hash,
                    root=root,
                )

    def test_incomplete_physical_evidence_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "incomplete"):
            evaluate(
                {"schemaVersion": 1, "model": {"sha256": "a" * 64}},
                {"schemaVersion": 1},
                {
                    "schemaVersion": 1,
                    "source": "physical_android_instrumentation",
                    "complete": False,
                },
                {"schemaVersion": 1},
                "b" * 64,
            )


if __name__ == "__main__":
    unittest.main()
