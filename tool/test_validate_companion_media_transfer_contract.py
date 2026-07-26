from __future__ import annotations

import copy
import unittest

from tool.validate_companion_media_transfer_contract import (
    ContractError,
    PROTOCOL,
    sample_manifest,
    validate_envelope,
    validate_manifest,
    validate_repository,
)


class CompanionMediaTransferContractTest(unittest.TestCase):
    def test_repository_and_samples_are_valid(self) -> None:
        validate_repository()
        self.assertEqual(validate_manifest(sample_manifest())["schema"], PROTOCOL)

    def test_manifest_rejects_unknown_fields_and_bad_chunk_math(self) -> None:
        manifest = sample_manifest()
        manifest["sourcePath"] = "/private/mobile/meeting.wav"
        with self.assertRaisesRegex(ContractError, "exact"):
            validate_manifest(manifest)

        manifest = sample_manifest()
        manifest["chunkCount"] = 1
        with self.assertRaisesRegex(ContractError, "does not match"):
            validate_manifest(manifest)

    def test_envelope_rejects_secrets_and_oversized_metadata(self) -> None:
        envelope = {
            "schema": PROTOCOL,
            "type": "manifest",
            "messageId": "message-1",
            "sessionId": "session-1",
            "counter": 0,
            "payload": {"privateKey": "forbidden"},
        }
        with self.assertRaisesRegex(ContractError, "secret-bearing"):
            validate_envelope(envelope)

        oversized = copy.deepcopy(envelope)
        oversized["payload"] = {"message": "x" * (64 * 1024)}
        with self.assertRaisesRegex(ContractError, "metadata"):
            validate_envelope(oversized)

    def test_envelope_rejects_provider_schema_alias(self) -> None:
        envelope = {
            "schema": "meeting_intelligence_provider/v1",
            "type": "manifest",
            "messageId": "message-1",
            "sessionId": "session-1",
            "counter": 0,
            "payload": {},
        }
        with self.assertRaisesRegex(ContractError, "schema"):
            validate_envelope(envelope)


if __name__ == "__main__":
    unittest.main()
