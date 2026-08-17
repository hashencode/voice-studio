#!/usr/bin/env python3
"""Fail-closed semantic validator for the future paired-PC protocol."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = ROOT / "docs/contracts/audio-intelligence-provider-v1.schema.json"
PROTOCOL_SCHEMA = "audio_intelligence_provider/v1"
OUTPUT_SCHEMA = "audio_intelligence_output/v1"
INPUT_SCHEMA = "audio_intelligence_input/v1"
REQUIRED_CAPABILITY = "audio_intelligence.generate.v1"
ALLOWED_CAPABILITIES = {
    REQUIRED_CAPABILITY,
    "audio_intelligence.progress.v1",
    "audio_intelligence.cancel.v1",
    "audio_intelligence.retry.v1",
}
ALLOWED_MESSAGE_TYPES = {
    "pairingOffer",
    "pairingAccept",
    "jobRequest",
    "jobProgress",
    "jobCancel",
    "jobResult",
}
SECRET_FIELD = re.compile(
    r"(api[_-]?key|authorization|bearer|token|password|secret|private[_-]?key|cookie)",
    re.IGNORECASE,
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]{16,256}$")


class ContractError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _string(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value), f"{label} must be a non-empty string")
    return value


def _reject_secret_fields(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            _require(
                not SECRET_FIELD.search(str(key)),
                f"secret-bearing field is forbidden at {path}.{key}",
            )
            _reject_secret_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_secret_fields(child, f"{path}[{index}]")


def canonical_input_hash(input_payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        input_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_message(
    message: dict[str, Any],
    *,
    now_ms: int | None = None,
    consumed_challenges: Iterable[tuple[str, str]] = (),
    expected_job_id: str | None = None,
    expected_idempotency_key: str | None = None,
    expected_input_hash: str | None = None,
) -> dict[str, Any]:
    message = _mapping(message, "message")
    _reject_secret_fields(message)
    _require(message.get("schemaVersion") == PROTOCOL_SCHEMA, "unsupported schemaVersion")
    _require(message.get("protocolVersion") == 1, "unsupported protocolVersion")
    message_type = message.get("messageType")
    _require(message_type in ALLOWED_MESSAGE_TYPES, "unsupported messageType")
    session_id = _string(message.get("sessionId"), "sessionId")
    _require(len(session_id) >= 8, "sessionId is too short")

    if message_type == "pairingOffer":
        _validate_pairing_offer(
            message,
            now_ms=int(time.time() * 1000) if now_ms is None else now_ms,
            consumed_challenges=set(consumed_challenges),
        )
    elif message_type == "pairingAccept":
        _validate_pairing_accept(message)
    else:
        _validate_job_identity(
            message,
            expected_job_id=expected_job_id,
            expected_idempotency_key=expected_idempotency_key,
            expected_input_hash=expected_input_hash,
        )
        if message_type == "jobRequest":
            _validate_job_request(message)
        elif message_type == "jobProgress":
            progress = message.get("progressPercent")
            _require(isinstance(progress, int) and 0 <= progress <= 100, "invalid progress")
            _require(
                message.get("stage")
                in {"queued", "processing", "reducing", "validating", "completed"},
                "invalid progress stage",
            )
        elif message_type == "jobCancel":
            _string(message.get("reason"), "reason")
        elif message_type == "jobResult":
            _validate_result(message)
    return message


def _validate_capabilities(raw: Any) -> set[str]:
    _require(isinstance(raw, list) and bool(raw), "capabilities must be a non-empty array")
    _require(all(isinstance(item, str) for item in raw), "capabilities must be strings")
    capabilities = set(raw)
    _require(len(capabilities) == len(raw), "capabilities must be unique")
    _require(capabilities <= ALLOWED_CAPABILITIES, "unsupported capability")
    _require(REQUIRED_CAPABILITY in capabilities, "required capability was not negotiated")
    return capabilities


def _validate_pairing_offer(
    message: dict[str, Any],
    *,
    now_ms: int,
    consumed_challenges: set[tuple[str, str]],
) -> None:
    endpoint = urlsplit(_string(message.get("endpoint"), "endpoint"))
    _require(endpoint.scheme == "wss", "pairing endpoint must use wss")
    _require(bool(endpoint.hostname), "pairing endpoint host is required")
    _require(endpoint.username is None and endpoint.password is None, "endpoint user info is forbidden")
    _require(not endpoint.query and not endpoint.fragment, "endpoint query/fragment is forbidden")
    public_key = _string(message.get("serverPublicKey"), "serverPublicKey")
    challenge = _string(message.get("challenge"), "challenge")
    _require(BASE64URL.fullmatch(public_key) is not None, "invalid serverPublicKey")
    _require(BASE64URL.fullmatch(challenge) is not None, "invalid challenge")
    fingerprint = _string(message.get("publicKeyFingerprint"), "publicKeyFingerprint")
    _require(SHA256.fullmatch(fingerprint) is not None, "invalid publicKeyFingerprint")
    issued = message.get("issuedAtMs")
    expires = message.get("expiresAtMs")
    _require(isinstance(issued, int) and isinstance(expires, int), "offer timestamps are required")
    _require(issued <= now_ms <= expires, "pairing offer is expired or not yet valid")
    _require(expires - issued <= 120_000, "pairing offer lifetime exceeds 120 seconds")
    _require((message["sessionId"], challenge) not in consumed_challenges, "replayed challenge")
    _validate_capabilities(message.get("capabilities"))
    _require(message.get("processingLocation") == "pairedPc", "pairing must use pairedPc")
    _string(message.get("providerId"), "providerId")
    _string(message.get("modelId"), "modelId")


def _validate_pairing_accept(message: dict[str, Any]) -> None:
    _require(BASE64URL.fullmatch(_string(message.get("challenge"), "challenge")), "invalid challenge")
    _require(
        BASE64URL.fullmatch(_string(message.get("challengeProof"), "challengeProof")),
        "invalid challenge proof",
    )
    _validate_capabilities(message.get("capabilities"))
    _require(message.get("processingLocation") == "pairedPc", "pairing must use pairedPc")


def _validate_job_identity(
    message: dict[str, Any],
    *,
    expected_job_id: str | None,
    expected_idempotency_key: str | None,
    expected_input_hash: str | None,
) -> None:
    job_id = _string(message.get("jobId"), "jobId")
    idempotency_key = _string(message.get("idempotencyKey"), "idempotencyKey")
    input_hash = _string(message.get("inputHash"), "inputHash")
    _require(SHA256.fullmatch(input_hash) is not None, "inputHash must be SHA-256")
    if expected_job_id is not None:
        _require(job_id == expected_job_id, "jobId mismatch")
    if expected_idempotency_key is not None:
        _require(idempotency_key == expected_idempotency_key, "idempotencyKey mismatch")
    if expected_input_hash is not None:
        _require(input_hash == expected_input_hash, "inputHash mismatch")


def _validate_job_request(message: dict[str, Any]) -> None:
    _require(message.get("processingLocation") == "pairedPc", "job must use pairedPc")
    _string(message.get("providerId"), "providerId")
    _string(message.get("modelId"), "modelId")
    payload = _mapping(message.get("input"), "input")
    _require(payload.get("schema_version") == INPUT_SCHEMA, "unsupported input schema")
    segments = payload.get("segments")
    _require(isinstance(segments, list) and bool(segments), "input segments are required")
    start = payload.get("input_start_ms")
    end = payload.get("input_end_ms")
    _require(isinstance(start, int) and isinstance(end, int) and 0 <= start < end, "invalid input range")
    for index, raw in enumerate(segments):
        segment = _mapping(raw, f"segments[{index}]")
        _require(
            set(segment) <= {"segment_id", "start_ms", "end_ms", "text", "speaker_label"},
            f"segments[{index}] has unknown fields",
        )
        segment_start = segment.get("start_ms")
        segment_end = segment.get("end_ms")
        _require(
            isinstance(segment.get("segment_id"), int)
            and isinstance(segment_start, int)
            and isinstance(segment_end, int)
            and start <= segment_start < segment_end <= end,
            f"segments[{index}] has invalid bounds",
        )
        _string(segment.get("text"), f"segments[{index}].text")
    _require(message["inputHash"] == canonical_input_hash(payload), "inputHash does not match canonical input")


def _validate_result(message: dict[str, Any]) -> None:
    _require(message.get("processingLocation") == "pairedPc", "result must use pairedPc")
    _string(message.get("providerId"), "providerId")
    _string(message.get("modelId"), "modelId")
    output = _mapping(message.get("output"), "output")
    _require(output.get("schema_version") == OUTPUT_SCHEMA, "unsupported output schema")
    _require(set(output) <= {"schema_version", "audio_type", "suggested_title", "items"}, "output has unknown fields")
    items = output.get("items")
    _require(isinstance(items, list) and len(items) <= 200, "invalid output items")
    for index, raw in enumerate(items):
        item = _mapping(raw, f"items[{index}]")
        _string(item.get("body"), f"items[{index}].body")
        _require(
            item.get("kind")
            in {
                "title",
                "summary",
                "summaryKeyPoint",
                "summaryDetailed",
                "topic",
                "decision",
                "action",
                "risk",
                "unresolved",
            },
            f"items[{index}] has invalid kind",
        )
        evidence = item.get("evidence")
        _require(isinstance(evidence, list) and len(evidence) <= 20, "invalid evidence")


def _validate_schema_document(schema: dict[str, Any]) -> None:
    _require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema draft mismatch")
    properties = _mapping(schema.get("properties"), "schema.properties")
    _require(properties["schemaVersion"].get("const") == PROTOCOL_SCHEMA, "schema version vocabulary mismatch")
    _require(properties["processingLocation"].get("const") == "pairedPc", "location vocabulary mismatch")
    output = schema.get("$defs", {}).get("audioOutput", {})
    _require(
        output.get("properties", {}).get("schema_version", {}).get("const") == OUTPUT_SCHEMA,
        "output schema vocabulary mismatch",
    )
    serialized = json.dumps(schema, sort_keys=True)
    _require(SECRET_FIELD.search(serialized) is None, "schema contains secret-bearing field names")


def sample_messages(now_ms: int = 1_784_990_000_000) -> tuple[dict[str, Any], dict[str, Any]]:
    offer = {
        "schemaVersion": PROTOCOL_SCHEMA,
        "messageType": "pairingOffer",
        "protocolVersion": 1,
        "sessionId": "session-018f3da0",
        "endpoint": "wss://pc.example.invalid/audio-intelligence/v1",
        "serverPublicKey": "A" * 43,
        "publicKeyFingerprint": "a" * 64,
        "challenge": "B" * 43,
        "issuedAtMs": now_ms - 1_000,
        "expiresAtMs": now_ms + 119_000,
        "capabilities": [
            REQUIRED_CAPABILITY,
            "audio_intelligence.progress.v1",
            "audio_intelligence.cancel.v1",
        ],
        "providerId": "pc-provider",
        "modelId": "pc-model",
        "processingLocation": "pairedPc",
    }
    input_payload = {
        "schema_version": INPUT_SCHEMA,
        "template_id": "general",
        "input_start_ms": 0,
        "input_end_ms": 2_000,
        "segments": [
            {"segment_id": 1, "start_ms": 0, "end_ms": 1_200, "text": "示例音频内容"}
        ],
    }
    request = {
        "schemaVersion": PROTOCOL_SCHEMA,
        "messageType": "jobRequest",
        "protocolVersion": 1,
        "sessionId": offer["sessionId"],
        "jobId": "job-018f3da0",
        "idempotencyKey": "idempotency-018f3da0",
        "inputHash": canonical_input_hash(input_payload),
        "providerId": offer["providerId"],
        "modelId": offer["modelId"],
        "processingLocation": "pairedPc",
        "input": input_payload,
    }
    return offer, request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("schema", nargs="?", default=str(DEFAULT_SCHEMA))
    args = parser.parse_args()
    try:
        schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
        _validate_schema_document(schema)
        now_ms = 1_784_990_000_000
        for message in sample_messages(now_ms):
            validate_message(message, now_ms=now_ms)
    except (OSError, json.JSONDecodeError, ContractError) as error:
        print(f"FAIL: {error}")
        return 1
    print("PASS: paired-PC provider v1 contract is frozen and fail-closed")
    print("STATUS: DEFERRED_PC_RUNTIME_MISSING")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
