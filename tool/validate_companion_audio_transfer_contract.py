#!/usr/bin/env python3
"""Fail-closed semantic validator for companion Audio transfer v2."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "docs/contracts/companion-audio-transfer-v2.schema.json"
ARCHITECTURE_PATH = ROOT / "docs/architecture/companion-audio-transfer-v2.md"
PROVIDER_PATH = ROOT / "docs/contracts/audio-intelligence-provider-v1.schema.json"
PROTOCOL = "companion-audio-transfer/v2"
CAPABILITY = "audio-transfer/v2"
LEGACY_PROTOCOL = "companion-media-transfer/v1"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
ALLOWED_TYPES = {
    "discovery",
    "pairingTranscript",
    "capability",
    "manifest",
    "chunk",
    "checkpoint",
    "receipt",
    "cancel",
    "error",
}
SECRET_FIELD = re.compile(
    r"(credential|private[_-]?key|api[_-]?key|authorization|password|token|cookie)",
    re.IGNORECASE,
)


class ContractError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def reject_secret_fields(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            require(
                SECRET_FIELD.search(str(key)) is None,
                f"secret-bearing field is forbidden at {path}.{key}",
            )
            reject_secret_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_secret_fields(child, f"{path}[{index}]")


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    required = {
        "schema",
        "transferId",
        "sourceAssetId",
        "displayName",
        "sizeBytes",
        "wholeFileSha256",
        "chunkBytes",
        "chunkCount",
        "createdAtMs",
    }
    require(set(manifest) == required, "manifest fields must be exact")
    require(manifest["schema"] == PROTOCOL, "unsupported manifest schema")
    require(IDENTIFIER.fullmatch(manifest["transferId"]) is not None, "invalid transferId")
    require(IDENTIFIER.fullmatch(manifest["sourceAssetId"]) is not None, "invalid sourceAssetId")
    require(
        isinstance(manifest["displayName"], str) and 1 <= len(manifest["displayName"]) <= 160,
        "invalid displayName",
    )
    size = manifest["sizeBytes"]
    chunk_bytes = manifest["chunkBytes"]
    chunk_count = manifest["chunkCount"]
    require(isinstance(size, int) and 1 <= size <= 4 * 1024**3, "invalid sizeBytes")
    require(isinstance(chunk_bytes, int) and 4096 <= chunk_bytes <= 1024**2, "invalid chunkBytes")
    require(
        isinstance(chunk_count, int)
        and 1 <= chunk_count <= 65536
        and chunk_count == (size + chunk_bytes - 1) // chunk_bytes,
        "chunkCount does not match sizeBytes",
    )
    require(SHA256.fullmatch(manifest["wholeFileSha256"]) is not None, "invalid wholeFileSha256")
    require(isinstance(manifest["createdAtMs"], int) and manifest["createdAtMs"] >= 0, "invalid timestamp")
    return manifest


def validate_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    required = {"schema", "type", "messageId", "sessionId", "counter", "payload"}
    require(set(envelope) == required, "envelope fields must be exact")
    require(envelope["schema"] == PROTOCOL, "unsupported envelope schema")
    require(envelope["type"] in ALLOWED_TYPES, "unsupported message type")
    require(IDENTIFIER.fullmatch(envelope["messageId"]) is not None, "invalid messageId")
    require(IDENTIFIER.fullmatch(envelope["sessionId"]) is not None, "invalid sessionId")
    require(isinstance(envelope["counter"], int) and envelope["counter"] >= 0, "invalid counter")
    require(isinstance(envelope["payload"], dict), "payload must be an object")
    require(
        len(json.dumps(envelope, ensure_ascii=False).encode("utf-8")) <= 64 * 1024,
        "metadata exceeds limit",
    )
    reject_secret_fields(envelope)
    payload = envelope["payload"]
    if envelope["type"] == "manifest":
        validate_manifest(payload)
    elif envelope["type"] == "chunk":
        require(
            set(payload)
            == {"transferId", "index", "offset", "plaintextBytes", "sha256"},
            "chunk fields must be exact",
        )
        require(
            IDENTIFIER.fullmatch(payload["transferId"]) is not None,
            "invalid chunk transferId",
        )
        require(
            isinstance(payload["index"], int)
            and 0 <= payload["index"] < 65536
            and isinstance(payload["offset"], int)
            and payload["offset"] >= 0
            and isinstance(payload["plaintextBytes"], int)
            and 1 <= payload["plaintextBytes"] <= 1024**2
            and SHA256.fullmatch(payload["sha256"]) is not None,
            "invalid chunk payload",
        )
    return envelope


def validate_repository() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    provider = json.loads(PROVIDER_PATH.read_text(encoding="utf-8"))
    architecture = ARCHITECTURE_PATH.read_text(encoding="utf-8")
    require(schema["properties"]["schema"]["const"] == PROTOCOL, "schema protocol mismatch")
    require(CAPABILITY not in json.dumps(provider), "provider v1 was extended with media transfer")
    require("audio_intelligence_provider/v1" not in json.dumps(schema), "Audio schema aliases provider v1")
    for phrase in (
        "Android Keystore",
        "macOS Keychain",
        "AES-256-GCM",
        "HKDF-SHA256",
        "missing chunk",
        "Audio processing queue",
        "retaining",
        "separate SQLite",
        CAPABILITY,
        "v1 schemas and capabilities are rejected",
    ):
        require(phrase in architecture, f"architecture omits {phrase}")


def sample_manifest() -> dict[str, Any]:
    return {
        "schema": PROTOCOL,
        "transferId": "transfer-sample-1",
        "sourceAssetId": "mobile-recording-1",
        "displayName": "audio.wav",
        "sizeBytes": 8192,
        "wholeFileSha256": "a" * 64,
        "chunkBytes": 4096,
        "chunkCount": 2,
        "createdAtMs": 1,
    }


def main() -> int:
    validate_repository()
    validate_manifest(sample_manifest())
    validate_envelope(
        {
            "schema": PROTOCOL,
            "type": "manifest",
            "messageId": "message-sample-1",
            "sessionId": "session-sample-1",
            "counter": 0,
            "payload": sample_manifest(),
        }
    )
    print("Companion Audio transfer v2 contract valid; v1 is rejection-only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
