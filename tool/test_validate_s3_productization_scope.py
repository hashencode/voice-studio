from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from tool.validate_s3_productization_scope import (
    DEFAULT_MANIFEST,
    reject_secret_bearing_diagnostics,
    validate_scope_contract,
)


class S3ProductizationScopeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))

    def _validate_mutation(self, manifest: dict) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "scope.json"
            path.write_text(
                json.dumps(manifest, ensure_ascii=False),
                encoding="utf-8",
            )
            validate_scope_contract(path, validate_documents=False)

    def test_repository_scope_computes_partial_not_full_s3(self) -> None:
        result = validate_scope_contract()

        self.assertEqual("PARTIAL_PASS", result["firstIncrement"])
        self.assertEqual("BLOCKED", result["fullS3"])
        self.assertEqual("NOT_RELEASE_READY", result["releaseReadiness"])

    def test_cloud_and_notes_pass_cannot_promote_full_s3(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["fullS3"]["status"] = "PASS"

        with self.assertRaisesRegex(ValueError, "derived full S3"):
            self._validate_mutation(manifest)

    def test_speaker_code_cannot_pass_without_evidence(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["speakerAdmission"].update(
            status="VERIFIED",
            verified=True,
            eligibleForProductization=True,
        )

        with self.assertRaisesRegex(ValueError, "speaker status must match"):
            self._validate_mutation(manifest)

    def test_speaker_manifest_hash_is_required(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["speakerAdmission"]["manifestSha256"] = "0" * 64

        with self.assertRaisesRegex(ValueError, "speaker manifest evidence hash"):
            self._validate_mutation(manifest)

    def test_speaker_contract_hash_is_required(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["speakerAdmission"]["contractSha256"] = "0" * 64

        with self.assertRaisesRegex(ValueError, "speaker contract hash"):
            self._validate_mutation(manifest)

    def test_scope_cannot_open_product_from_admission_result(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["speakerAdmission"]["productAvailable"] = True

        with self.assertRaisesRegex(ValueError, "product must remain unavailable"):
            self._validate_mutation(manifest)

    def test_pc_contract_does_not_equal_runtime(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["pairedPc"]["status"] = "PASS"

        with self.assertRaisesRegex(ValueError, "runtime, adapter"):
            self._validate_mutation(manifest)

    def test_asr_005_cannot_return_to_development_scope(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["asr005"].update(
            status="BLOCKED",
            developmentBlocker=True,
        )

        with self.assertRaisesRegex(ValueError, "pre-release acceptance"):
            self._validate_mutation(manifest)

    def test_diagnostics_reject_credential_header_and_prompt_shapes(self) -> None:
        secret_prefix = "sk" + "-"
        fixtures = (
            secret_prefix + "x" * 24,
            "Authorization: Bearer fake-value",
            "api_key=fake-value",
            "full_prompt=fictional audio text",
        )
        for fixture in fixtures:
            with self.subTest(fixture=fixture.split("=")[0]):
                with self.assertRaisesRegex(ValueError, "diagnostics contain"):
                    reject_secret_bearing_diagnostics(fixture)

    def test_redacted_diagnostics_are_allowed(self) -> None:
        reject_secret_bearing_diagnostics(
            "provider=deepseek status=rateLimited requestBody=[REDACTED]"
        )


if __name__ == "__main__":
    unittest.main()
