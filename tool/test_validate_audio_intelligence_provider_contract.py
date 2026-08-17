from __future__ import annotations

import copy
import unittest

from tool.validate_audio_intelligence_provider_contract import (
    ContractError,
    canonical_input_hash,
    sample_messages,
    validate_message,
)


class AudioIntelligenceProviderContractTest(unittest.TestCase):
    NOW_MS = 1_784_990_000_000

    def setUp(self) -> None:
        self.offer, self.request = sample_messages(self.NOW_MS)

    def test_valid_offer_and_request_round_trip(self) -> None:
        self.assertEqual(
            self.offer,
            validate_message(self.offer, now_ms=self.NOW_MS),
        )
        self.assertEqual(
            self.request,
            validate_message(self.request, now_ms=self.NOW_MS),
        )
        self.assertEqual(
            self.request["inputHash"],
            canonical_input_hash(self.request["input"]),
        )

    def test_qr_with_api_key_fails(self) -> None:
        offer = copy.deepcopy(self.offer)
        offer["api_key"] = "not-a-real-key"

        with self.assertRaisesRegex(ContractError, "secret-bearing"):
            validate_message(offer, now_ms=self.NOW_MS)

    def test_expired_challenge_fails(self) -> None:
        with self.assertRaisesRegex(ContractError, "expired"):
            validate_message(self.offer, now_ms=self.offer["expiresAtMs"] + 1)

    def test_replayed_challenge_fails(self) -> None:
        consumed = {(self.offer["sessionId"], self.offer["challenge"])}

        with self.assertRaisesRegex(ContractError, "replayed"):
            validate_message(
                self.offer,
                now_ms=self.NOW_MS,
                consumed_challenges=consumed,
            )

    def test_unsupported_protocol_fails(self) -> None:
        offer = copy.deepcopy(self.offer)
        offer["protocolVersion"] = 2

        with self.assertRaisesRegex(ContractError, "protocolVersion"):
            validate_message(offer, now_ms=self.NOW_MS)

    def test_unsupported_capability_fails(self) -> None:
        offer = copy.deepcopy(self.offer)
        offer["capabilities"].append("audio_intelligence.anything.v9")

        with self.assertRaisesRegex(ContractError, "unsupported capability"):
            validate_message(offer, now_ms=self.NOW_MS)

    def test_result_with_mismatched_identity_fails(self) -> None:
        result = self._result_message()

        with self.assertRaisesRegex(ContractError, "inputHash mismatch"):
            validate_message(
                result,
                expected_job_id=self.request["jobId"],
                expected_idempotency_key=self.request["idempotencyKey"],
                expected_input_hash="f" * 64,
            )

    def test_request_input_hash_must_match_canonical_payload(self) -> None:
        request = copy.deepcopy(self.request)
        request["input"]["segments"][0]["text"] = "被篡改"

        with self.assertRaisesRegex(ContractError, "canonical input"):
            validate_message(request)

    def _result_message(self) -> dict:
        return {
            "schemaVersion": self.request["schemaVersion"],
            "messageType": "jobResult",
            "protocolVersion": 1,
            "sessionId": self.request["sessionId"],
            "jobId": self.request["jobId"],
            "idempotencyKey": self.request["idempotencyKey"],
            "inputHash": self.request["inputHash"],
            "providerId": self.request["providerId"],
            "modelId": self.request["modelId"],
            "processingLocation": "pairedPc",
            "output": {
                "schema_version": "audio_intelligence_output/v1",
                "audio_type": "general",
                "suggested_title": "示例",
                "items": [],
            },
        }


if __name__ == "__main__":
    unittest.main()
