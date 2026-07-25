#!/usr/bin/env python3
"""Validate the auditable S2 ASR model-admission registry."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = ROOT / "benchmark" / "asr_model_candidates.json"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CAPABILITY_STATES = {
    "verified",
    "documented",
    "available_unverified",
    "unavailable",
    "unknown",
}
ADMISSION_STATES = {"blocked", "lab_only", "production_eligible"}
REQUIRED_CAPABILITIES = {
    "timestamps",
    "scoreSignal",
    "decoderHotwords",
    "itn",
    "offline",
}
REQUIRED_PRODUCTION_GATES = {
    "accuracy",
    "timestamps",
    "hotwords",
    "confidenceCalibration",
    "itn",
    "rtf",
    "peakMemory",
    "thermalBattery",
    "packageSize",
}


class RegistryValidationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RegistryValidationError(message)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_license(
    license_payload: dict[str, Any],
    *,
    label: str,
) -> None:
    status = license_payload.get("status")
    _require(status in {"clear", "unknown", "restricted"}, f"{label}: invalid license status")
    if status == "clear":
        _require(bool(license_payload.get("spdx")), f"{label}: clear license requires SPDX")
        _require(bool(license_payload.get("evidence")), f"{label}: clear license requires evidence")


def validate_registry(
    payload: dict[str, Any],
    *,
    root: Path = ROOT,
    verify_local_artifacts: bool = True,
) -> None:
    _require(payload.get("schemaVersion") == 1, "schemaVersion must be 1")
    _validate_license(payload.get("runtime", {}).get("license", {}), label="runtime")
    runtime_sha = payload.get("runtime", {}).get("sha256")
    _require(bool(SHA256_PATTERN.fullmatch(runtime_sha or "")), "runtime sha256 is invalid")

    required_devices = set(payload.get("requiredDeviceClasses", []))
    _require(required_devices == {"low", "mid"}, "requiredDeviceClasses must contain low and mid")

    candidates = payload.get("candidates")
    _require(isinstance(candidates, list) and candidates, "candidates must be a non-empty list")
    seen_ids: set[str] = set()
    for candidate in candidates:
        candidate_id = candidate.get("id", "<missing>")
        _require(candidate_id not in seen_ids, f"{candidate_id}: duplicate candidate id")
        seen_ids.add(candidate_id)
        _require(
            candidate.get("role")
            in {
                "production_baseline",
                "upgrade_candidate",
                "screening_candidate",
                "comparison_candidate",
            },
            f"{candidate_id}: invalid role",
        )
        _require(bool(candidate.get("modelSource")), f"{candidate_id}: modelSource is required")
        _require(bool(candidate.get("modelCard")), f"{candidate_id}: modelCard is required")
        _validate_license(candidate.get("modelLicense", {}), label=f"{candidate_id} model")

        artifact = candidate.get("artifact", {})
        artifact_sha = artifact.get("sha256")
        if artifact_sha is not None:
            _require(
                bool(SHA256_PATTERN.fullmatch(artifact_sha)),
                f"{candidate_id}: artifact sha256 is invalid",
            )
        artifact_path = artifact.get("path")
        if artifact.get("kind") == "download" and artifact.get("requiredFiles"):
            required_files = artifact["requiredFiles"]
            required_hashes = artifact.get("requiredFileSha256", {})
            _require(
                set(required_hashes) == set(required_files),
                f"{candidate_id}: every required file needs a pinned sha256",
            )
            for file_key, file_hash in required_hashes.items():
                _require(
                    bool(SHA256_PATTERN.fullmatch(file_hash or "")),
                    f"{candidate_id}: invalid required-file sha256 for {file_key}",
                )
        if verify_local_artifacts and artifact_path:
            local_path = root / artifact_path
            _require(local_path.is_file(), f"{candidate_id}: artifact does not exist: {artifact_path}")
            contents = local_path.read_bytes()
            if contents.startswith(b"version https://git-lfs.github.com/spec/v1"):
                pointer = contents.decode("utf-8")
                _require(
                    f"oid sha256:{artifact_sha}" in pointer,
                    f"{candidate_id}: Git LFS oid does not match registry sha256",
                )
                _require(
                    f"size {artifact.get('bytes')}" in pointer,
                    f"{candidate_id}: Git LFS size does not match registry bytes",
                )
            else:
                _require(
                    _sha256(local_path) == artifact_sha,
                    f"{candidate_id}: local artifact sha256 mismatch",
                )

        capabilities = candidate.get("capabilities", {})
        _require(
            set(capabilities) == REQUIRED_CAPABILITIES,
            f"{candidate_id}: capabilities must be exactly {sorted(REQUIRED_CAPABILITIES)}",
        )
        for capability, state in capabilities.items():
            _require(
                state in CAPABILITY_STATES,
                f"{candidate_id}: invalid {capability} state {state!r}",
            )

        admission = candidate.get("admission", {})
        state = admission.get("state")
        reasons = admission.get("reasons")
        _require(state in ADMISSION_STATES, f"{candidate_id}: invalid admission state")
        _require(isinstance(reasons, list), f"{candidate_id}: admission reasons must be a list")
        if state == "production_eligible":
            _require(not reasons, f"{candidate_id}: production-eligible candidate cannot have blockers")
            _require(
                candidate["modelLicense"]["status"] == "clear",
                f"{candidate_id}: production eligibility requires a clear model license",
            )
            _require(
                artifact_sha is not None,
                f"{candidate_id}: production eligibility requires a pinned artifact sha256",
            )
            _require(
                isinstance(artifact.get("bytes"), int) and artifact["bytes"] > 0,
                f"{candidate_id}: production eligibility requires pinned artifact bytes",
            )
            if artifact.get("kind") == "download":
                _require(
                    bool(artifact.get("archiveName"))
                    and bool(artifact.get("extractedDir"))
                    and bool(artifact.get("requiredFiles"))
                    and set(artifact.get("requiredFileSha256", {}))
                    == set(artifact["requiredFiles"]),
                    f"{candidate_id}: downloadable production artifact requires "
                    "pinned archive and required-file hashes",
                )
            for capability, capability_state in capabilities.items():
                _require(
                    capability_state == "verified",
                    f"{candidate_id}: production eligibility requires verified {capability}",
                )
            gates = admission.get("gates", {})
            _require(
                set(gates) == REQUIRED_PRODUCTION_GATES,
                f"{candidate_id}: production eligibility requires every benchmark gate",
            )
            for gate_name, gate in gates.items():
                _require(
                    isinstance(gate, dict)
                    and gate.get("status") == "pass"
                    and bool(SHA256_PATTERN.fullmatch(str(gate.get("reportSha256", "")))),
                    f"{candidate_id}: production gate {gate_name} needs a pinned PASS report",
                )
            device_evidence = admission.get("deviceEvidence", {})
            _require(
                set(device_evidence) == required_devices,
                f"{candidate_id}: production eligibility requires low and mid device evidence",
            )
            for device_class, evidence in device_evidence.items():
                _require(
                    isinstance(evidence, dict)
                    and evidence.get("status") == "pass"
                    and bool(
                        SHA256_PATTERN.fullmatch(
                            str(evidence.get("reportSha256", ""))
                        )
                    ),
                    f"{candidate_id}: {device_class} device evidence needs a pinned PASS report",
                )
        else:
            _require(bool(reasons), f"{candidate_id}: non-eligible candidate requires blockers")

        if candidate.get("family") == "offline_paraformer":
            _require(
                capabilities["scoreSignal"] == "unavailable",
                f"{candidate_id}: current Paraformer cannot claim a score signal",
            )
            _require(
                capabilities["decoderHotwords"] == "unavailable",
                f"{candidate_id}: current Paraformer cannot claim decoder hotwords",
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--skip-local-artifacts", action="store_true")
    args = parser.parse_args()
    try:
        payload = json.loads(args.registry.read_text(encoding="utf-8"))
        validate_registry(
            payload,
            root=ROOT,
            verify_local_artifacts=not args.skip_local_artifacts,
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ASR model candidate registry blocked: {error}")
        return 1
    print(f"ASR model candidate registry valid: {args.registry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
