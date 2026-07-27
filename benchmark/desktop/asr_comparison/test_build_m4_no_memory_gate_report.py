from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from build_m4_no_memory_gate_report import (
    QWEN3,
    _disposition_table,
    _qwen_stage,
    build_markdown,
)


class M4NoMemoryGateReportTest(unittest.TestCase):
    def test_disposition_table_keeps_reason_visible(self) -> None:
        table = _disposition_table(
            [
                {
                    "languageLane": "en",
                    "candidateId": "candidate",
                    "disposition": "REJECTED_QUALITY_GATE",
                    "reason": "WER exceeds 35%",
                }
            ]
        )
        self.assertIn("REJECTED_QUALITY_GATE", table)
        self.assertIn("WER exceeds 35%", table)

    def test_markdown_marks_qwen_streaming_as_unsupported(self) -> None:
        report = {
            "stability": [],
            "development": [],
            "heldOut": [],
            "operational": [],
            "candidateDispositions": [],
        }
        markdown = build_markdown(report)
        self.assertIn("`not_applicable` / `unsupported`", markdown)
        self.assertIn("does not emit streaming partials", markdown)
        self.assertIn("Silero VAD", markdown)

    def test_qwen_stage_rejects_evidence_from_another_experiment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "stability" / "zh"
            target.mkdir(parents=True)
            (target / "summary.json").write_text(
                json.dumps(
                    {
                        "kind": "m4_qwen3_asr_formal_evidence",
                        "stage": "stability",
                        "candidateId": QWEN3,
                        "languageLane": "zh",
                        "profileId": "fixed-resource",
                        "rankEligible": True,
                        "experimentManifestSha256": "wrong",
                        "selectionPolicy": {"memory": "advisory"},
                        "aggregate": {"measuredRunCount": 5},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "invalid Qwen3"):
                _qwen_stage(
                    root,
                    "stability",
                    "zh",
                    experiment_sha256="expected",
                    selection_policy={"memory": "advisory"},
                )


if __name__ == "__main__":
    unittest.main()
