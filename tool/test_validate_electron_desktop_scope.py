from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tool.validate_electron_desktop_scope import (
    ACCESSIBILITY_CHECK_IDS,
    CAPABILITY_IDS,
    EXPECTED_CAPABILITY_BINDINGS,
    RELEVANT_SOURCE_PATHS,
    _relevant_source_sha256,
    _validate_live_source_binding,
    validate_electron_desktop_scope,
)


SHA256 = "a" * 64
ROOT = Path(__file__).resolve().parents[1]
TARGET = {
    "modelIdentifier": "Mac14,3",
    "operatingSystem": "macOS",
    "operatingSystemVersion": "15.7.5",
    "operatingSystemBuild": "24G624",
    "architecture": "arm64",
    "cpuModel": "Apple M2",
    "logicalCpuCount": 8,
    "memoryBytes": 17179869184,
    "buildMode": "development-package",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _bundle_manifest_sha256(bundle: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(bundle.rglob("*")):
        relative = path.relative_to(bundle).as_posix()
        if path.is_symlink():
            kind = "symlink"
            content = os.readlink(path).encode()
        elif path.is_file():
            kind = "file"
            content = hashlib.sha256(path.read_bytes()).hexdigest().encode()
        else:
            continue
        digest.update(kind.encode())
        digest.update(b"\0")
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\n")
    return digest.hexdigest()


class ElectronDesktopScopeValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.scope_path = self.root / "docs/product/desktop-electron-scope.json"
        self.evidence_path = (
            self.root / "docs/product/desktop-electron-evidence.json"
        )
        self.scope_path.parent.mkdir(parents=True)
        self.bundle = (
            self.root
            / "apps/desktop-electron/out/Voice2Text-darwin-arm64/Voice2Text.app"
        )
        self._write_bundle()
        self.baseline = self._write_reference_baseline()
        self.evidence = self._valid_evidence()
        self.scope = self._valid_scope(self.evidence)
        self._write_documents()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write(self, relative: str, content: bytes = b"fixture\n") -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def _write_bundle(self) -> None:
        files = {
            "Contents/MacOS/Voice2Text": b"app-executable",
            "Contents/Resources/app.asar": b"asar",
            "Contents/Info.plist": b"plist",
            "Contents/Resources/native/macos/bin/desktop_macos_native_helper": b"helper",
            "Contents/Resources/worker/bin/desktop_sherpa_worker": b"asr",
            "Contents/Resources/worker/bin/desktop_sensevoice_caption_worker": b"caption",
            "Contents/Resources/worker/bin/native_process_group_launcher": b"launcher",
            "Contents/Resources/worker/runtime/libonnxruntime.1.27.0.dylib": b"ort",
            "Contents/Resources/worker/runtime/libsherpa-onnx-c-api.dylib": b"c-api",
            "Contents/Resources/worker/runtime/libsherpa-onnx-cxx-api.dylib": b"cxx-api",
            "Contents/Resources/worker/manifest.json": b"manifest",
            "Contents/Resources/worker/models/asr/encoder.int8.onnx": b"asr-model",
            "Contents/Resources/worker/models/live-caption/model.int8.onnx": b"caption-model",
        }
        for relative, content in files.items():
            path = self.bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)

    def _write_reference_baseline(self) -> dict:
        frozen = []
        for index in range(3):
            relative = f"reference/frozen-{index}.txt"
            path = self._write(relative, f"frozen-{index}\n".encode())
            frozen.append({"path": relative, "sha256": _sha256(path)})
        baseline = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "schema": "voice2text-desktop-electron-parity-baseline/v1",
            "frozenAt": "2026-08-14",
            "status": "frozen",
            "flutterReference": {
                "repositoryRevision": "8333ffe07017cde582c036fb83816dd0f8dfd603",
                "desktopSourceLastChangeRevision": (
                    "6a9a27732ebdc8271d15006b1b05d2be5e9db61e"
                ),
                "sourceRoot": "apps/desktop",
                "runtimeUse": "reference-only",
                "prohibitedActions": [
                    "launch-flutter-desktop",
                    "inspect-flutter-runtime-profile",
                    "copy-or-migrate-flutter-runtime-profile",
                    "use-flutter-as-runtime-fallback",
                ],
            },
            "capabilityInventory": [
                {"id": capability, "scope": "fixture"}
                for capability in CAPABILITY_IDS
            ],
            "fixtures": frozen,
            "acceptanceEvidence": [],
            "referenceChangePolicy": {
                "comparisonBaseRevision": (
                    "8333ffe07017cde582c036fb83816dd0f8dfd603"
                ),
                "rule": "fixture",
                "allowedDispositions": [
                    "adopted-with-electron-evidence",
                    "not-applicable-with-rationale",
                    "deferred-and-parity-blocked",
                    "rejected-as-reference-regression",
                ],
                "requiredFields": [
                    "flutterRevision",
                    "changedCapabilityIds",
                    "disposition",
                    "rationale",
                    "electronEvidence",
                ],
                "changes": [],
            },
        }
        path = self.root / "docs/product/desktop-electron-parity-baseline.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(baseline), encoding="utf-8")
        baseline["path"] = path.relative_to(self.root).as_posix()
        baseline["sha256"] = _sha256(path)
        baseline["frozenFiles"] = frozen
        return baseline

    def _artifact_binding(self, identifier: str, relative: str, kind: str) -> dict:
        path = self.root / relative
        return {
            "id": identifier,
            "kind": kind,
            "path": relative,
            "sha256": _sha256(path),
            "outsideAsar": kind not in {"application", "renderer"},
        }

    def _valid_evidence(self) -> dict:
        bundle_relative = self.bundle.relative_to(self.root).as_posix()
        artifacts = [
            self._artifact_binding(
                "app-executable",
                f"{bundle_relative}/Contents/MacOS/Voice2Text",
                "application",
            ),
            self._artifact_binding(
                "app-asar",
                f"{bundle_relative}/Contents/Resources/app.asar",
                "renderer",
            ),
            self._artifact_binding(
                "info-plist",
                f"{bundle_relative}/Contents/Info.plist",
                "application",
            ),
            self._artifact_binding(
                "native-helper",
                f"{bundle_relative}/Contents/Resources/native/macos/bin/desktop_macos_native_helper",
                "helper",
            ),
            self._artifact_binding(
                "asr-worker",
                f"{bundle_relative}/Contents/Resources/worker/bin/desktop_sherpa_worker",
                "worker",
            ),
            self._artifact_binding(
                "caption-worker",
                f"{bundle_relative}/Contents/Resources/worker/bin/desktop_sensevoice_caption_worker",
                "worker",
            ),
            self._artifact_binding(
                "process-group-launcher",
                f"{bundle_relative}/Contents/Resources/worker/bin/native_process_group_launcher",
                "worker",
            ),
            self._artifact_binding(
                "onnxruntime",
                f"{bundle_relative}/Contents/Resources/worker/runtime/libonnxruntime.1.27.0.dylib",
                "runtime",
            ),
            self._artifact_binding(
                "sherpa-c-api",
                f"{bundle_relative}/Contents/Resources/worker/runtime/libsherpa-onnx-c-api.dylib",
                "runtime",
            ),
            self._artifact_binding(
                "sherpa-cxx-api",
                f"{bundle_relative}/Contents/Resources/worker/runtime/libsherpa-onnx-cxx-api.dylib",
                "runtime",
            ),
            self._artifact_binding(
                "worker-manifest",
                f"{bundle_relative}/Contents/Resources/worker/manifest.json",
                "manifest",
            ),
            self._artifact_binding(
                "asr-model",
                f"{bundle_relative}/Contents/Resources/worker/models/asr/encoder.int8.onnx",
                "model",
            ),
            self._artifact_binding(
                "caption-model",
                f"{bundle_relative}/Contents/Resources/worker/models/live-caption/model.int8.onnx",
                "model",
            ),
        ]
        gate_path = self._write("evidence/automated-gate.txt", b"gate definition\n")
        manual_definition = self._write(
            "evidence/manual-voiceover-procedure.txt",
            b"bounded VoiceOver procedure\n",
        )
        source_manifest = self._write("source/source-manifest.txt", b"source\n")
        package_json = self._write("apps/desktop-electron/package.json", b"{}\n")
        bun_lock = self._write("apps/desktop-electron/bun.lock", b"lock\n")
        entitlements = self._write(
            "apps/desktop-electron/native/macos/desktop-macos-native-helper.entitlements",
            b"entitlements\n",
        )
        target_sha = _json_sha256(TARGET)
        bundle_sha = _bundle_manifest_sha256(self.bundle)
        revision = "e" * 40
        relevant_source_sha = _sha256(source_manifest)
        evidence_bindings = []
        for capability in CAPABILITY_IDS:
            binding_id = f"gate-{capability}"
            receipt_path = self.root / f"evidence/receipts/{binding_id}.json"
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            receipt = {
                "schema": "voice2text-desktop-electron-gate-receipt/v1",
                "id": binding_id,
                "mode": "automated",
                "status": "PASS",
                "sourceRevision": revision,
                "relevantSourceSha256": relevant_source_sha,
                "targetFingerprintSha256": target_sha,
                "packageManifestSha256": bundle_sha,
                "definitionPath": gate_path.relative_to(self.root).as_posix(),
                "definitionSha256": _sha256(gate_path),
                "startedAt": "2026-08-15T12:00:00+08:00",
                "finishedAt": "2026-08-15T12:00:01+08:00",
                "elapsedMilliseconds": 1,
                "exitCode": 0,
                "commandId": binding_id,
                "procedureId": None,
                "checks": [],
            }
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            evidence_bindings.append(
                {
                    "id": binding_id,
                    "mode": "automated",
                    "status": "PASS",
                    "definitionPath": gate_path.relative_to(self.root).as_posix(),
                    "definitionSha256": _sha256(gate_path),
                    "receiptPath": receipt_path.relative_to(self.root).as_posix(),
                    "receiptSha256": _sha256(receipt_path),
                    "procedureId": None,
                    "maximumMinutes": None,
                    "elapsedMilliseconds": 1,
                    "targetFingerprintSha256": target_sha,
                    "packageManifestSha256": bundle_sha,
                }
            )
        manual_receipt_path = self.root / "evidence/receipts/manual-voiceover.json"
        manual_receipt = {
            "schema": "voice2text-desktop-electron-gate-receipt/v1",
            "id": "manual-voiceover",
            "mode": "bounded-manual",
            "status": "PASS",
            "sourceRevision": revision,
            "relevantSourceSha256": relevant_source_sha,
            "targetFingerprintSha256": target_sha,
            "packageManifestSha256": bundle_sha,
            "definitionPath": manual_definition.relative_to(self.root).as_posix(),
            "definitionSha256": _sha256(manual_definition),
            "startedAt": "2026-08-15T12:00:00+08:00",
            "finishedAt": "2026-08-15T12:01:00+08:00",
            "elapsedMilliseconds": 60_000,
            "exitCode": 0,
            "commandId": None,
            "procedureId": "macos-voiceover-navigation-v1",
            "checks": ["voiceover-navigation-observed"],
        }
        manual_receipt_path.write_text(json.dumps(manual_receipt), encoding="utf-8")
        evidence_bindings.append(
            {
                "id": "manual-voiceover",
                "mode": "bounded-manual",
                "status": "PASS",
                "definitionPath": manual_definition.relative_to(self.root).as_posix(),
                "definitionSha256": _sha256(manual_definition),
                "receiptPath": manual_receipt_path.relative_to(self.root).as_posix(),
                "receiptSha256": _sha256(manual_receipt_path),
                "procedureId": "macos-voiceover-navigation-v1",
                "maximumMinutes": 10,
                "elapsedMilliseconds": 60_000,
                "targetFingerprintSha256": target_sha,
                "packageManifestSha256": bundle_sha,
            }
        )
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "schema": "voice2text-desktop-electron-evidence/v1",
            "unit": "U12",
            "status": "PASS",
            "disposition": "MACOS_ELECTRON_CLOSED_FOR_WINDOWS_ENTRY",
            "developmentPosture": "DEVELOPMENT_ONLY",
            "capturedAt": "2026-08-15T12:00:00+08:00",
            "source": {
                "revision": revision,
                "tree": "f" * 40,
                "relevantSourceSha256": relevant_source_sha,
                "packageManifest": {
                    "path": package_json.relative_to(self.root).as_posix(),
                    "sha256": _sha256(package_json),
                },
                "dependencyLock": {
                    "path": bun_lock.relative_to(self.root).as_posix(),
                    "sha256": _sha256(bun_lock),
                },
            },
            "target": TARGET,
            "artifacts": {
                "status": "PASS",
                "bundle": {
                    "path": bundle_relative,
                    "hashScheme": "sorted-bundle-manifest-v1",
                    "manifestSha256": bundle_sha,
                },
                "bindings": artifacts,
                "signing": {
                    "appVerification": "PASS",
                    "helperVerification": "PASS",
                    "mode": "development",
                    "signatureMode": "adhoc",
                    "productionEntitlementsRequired": False,
                    "helperEntitlementsPath": entitlements.relative_to(
                        self.root
                    ).as_posix(),
                    "helperEntitlementsSha256": _sha256(entitlements),
                },
                "runtimeIsolation": {
                    "rendererUrlScheme": "file",
                    "viteDevelopmentServerUsed": False,
                    "repositoryPathUsedByPackagedApp": False,
                    "flutterBuildOutputUsed": False,
                    "pubCacheUsed": False,
                    "allExecutablesOutsideAsar": True,
                },
            },
            "referenceBaseline": {
                "path": self.baseline["path"],
                "sha256": self.baseline["sha256"],
                "comparisonBaseRevision": (
                    "8333ffe07017cde582c036fb83816dd0f8dfd603"
                ),
                "frozenFiles": self.baseline["frozenFiles"],
                "laterChanges": [],
                "flutterDesktopLaunched": False,
                "flutterRuntimeProfileInspected": False,
            },
            "evidenceBindings": evidence_bindings,
            "capabilityEvidence": [
                {
                    "id": capability,
                    "status": "PASS",
                    "evidenceBindingIds": EXPECTED_CAPABILITY_BINDINGS[capability],
                }
                for capability in CAPABILITY_IDS
            ],
            "accessibility": {
                "status": "PASS",
                "checks": [
                    {
                        "id": check,
                        "status": "PASS",
                        "evidenceBindingIds": (
                            ["manual-voiceover"]
                            if check == "voiceover"
                            else ["gate-accessibility.desktop"]
                        ),
                    }
                    for check in ACCESSIBILITY_CHECK_IDS
                ],
            },
            "privacy": {
                "status": "PASS",
                "schemaAllowlistEnforced": True,
                "sensitiveKeyDetected": False,
                "fullSensitivePathDetected": False,
                "repositoryPathDetected": False,
                "rawAudioOrTranscriptDetected": False,
                "reusableTokenDetected": False,
                "secretCanaryDetected": False,
                "scannedEvidenceBindingIds": [
                    binding["id"] for binding in evidence_bindings
                ],
            },
            "validationSessions": [
                {
                    "id": "macos-packaged-closure",
                    "status": "PASS",
                    "startedAt": "2026-08-15T12:00:00+08:00",
                    "finishedAt": "2026-08-15T12:10:00+08:00",
                    "elapsedMilliseconds": 600_000,
                    "maximumMilliseconds": 1_800_000,
                }
            ],
            "verification": {
                "electronStaticAndUnit": "PASS",
                "packagedMacos": "PASS",
                "packagedProductFlows": "PASS",
                "artifactInspection": "PASS",
                "privacy": "PASS",
                "accessibility": "PASS",
                "rootDevCheck": "PASS",
                "uiWatcher": "PASS",
            },
            "blockers": [],
        }

    def _valid_scope(self, evidence: dict) -> dict:
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "schema": "voice2text-desktop-electron-scope/v1",
            "developmentPosture": "DEVELOPMENT_ONLY",
            "application": {
                "compositionRoot": "apps/desktop-electron",
                "packageManager": "bun",
                "rendererBuild": "vite",
                "desktopPackaging": "electron-forge",
                "rendererStack": "react-typescript-shadcn-tailwind-sidebar-07",
                "flutterRuntimeFallback": False,
                "sharedRuntimeDatabase": False,
            },
            "referenceBaseline": {
                "path": self.baseline["path"],
                "sha256": self.baseline["sha256"],
                "runtimeUse": "reference-only",
                "prohibitedActions": [
                    "launch-flutter-desktop",
                    "inspect-flutter-runtime-profile",
                    "copy-or-migrate-flutter-runtime-profile",
                    "use-flutter-as-runtime-fallback",
                ],
            },
            "targets": {
                "macos": {
                    "status": "PASS",
                    "closureDisposition": (
                        "MACOS_ELECTRON_CLOSED_FOR_WINDOWS_ENTRY"
                    ),
                    "evidence": {
                        "path": self.evidence_path.relative_to(
                            self.root
                        ).as_posix(),
                        "sha256": _json_sha256(evidence),
                    },
                },
                "windows": {
                    "status": "READY_FOR_INDEPENDENT_U13",
                    "inheritsMacosPass": False,
                    "evidence": None,
                },
            },
            "capabilities": [
                {
                    "id": capability,
                    "status": "PASS",
                    "evidenceBindingIds": EXPECTED_CAPABILITY_BINDINGS[capability],
                }
                for capability in CAPABILITY_IDS
            ],
            "releaseExclusions": {
                "maximumValidationSessionMinutes": 30,
                "productionNotarization": False,
                "automaticUpdates": False,
                "storeSubmission": False,
                "releaseCandidateDeviceMatrix": False,
            },
        }

    def _write_documents(self) -> None:
        self.evidence_path.write_text(
            json.dumps(self.evidence, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        self.scope["targets"]["macos"]["evidence"]["sha256"] = _sha256(
            self.evidence_path
        )
        self.scope_path.write_text(
            json.dumps(self.scope, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )

    def _validate(self, *, allow_blocked: bool = False) -> dict:
        return validate_electron_desktop_scope(
            self.scope_path,
            evidence_path=self.evidence_path,
            root=self.root,
            validate_repository=False,
            current_target=TARGET,
            allow_blocked=allow_blocked,
        )

    def _mutate(self, callback) -> None:
        callback(self.scope, self.evidence)
        self._write_documents()

    def test_complete_current_package_can_pass(self) -> None:
        result = self._validate()
        self.assertEqual("PASS", result["status"])
        self.assertEqual(
            "MACOS_ELECTRON_CLOSED_FOR_WINDOWS_ENTRY",
            result["disposition"],
        )

    def test_truthful_blocked_state_is_structurally_valid_but_not_pass(self) -> None:
        def block(scope: dict, evidence: dict) -> None:
            scope["targets"]["macos"].update(
                status="BLOCKED",
                closureDisposition="MACOS_ELECTRON_CLOSURE_BLOCKED",
            )
            scope["targets"]["windows"]["status"] = "BLOCKED_BY_MACOS_CLOSURE"
            for capability in scope["capabilities"]:
                capability["status"] = "BLOCKED"
            evidence.update(
                status="BLOCKED",
                disposition="MACOS_ELECTRON_CLOSURE_BLOCKED",
            )
            evidence["artifacts"]["status"] = "NOT_RUN"
            for capability in evidence["capabilityEvidence"]:
                capability["status"] = "BLOCKED"
            for binding in evidence["evidenceBindings"]:
                binding["status"] = (
                    "NOT_RUN"
                    if binding["mode"] == "bounded-manual"
                    else "DEFINED_NOT_CAPTURED"
                )
                binding["receiptPath"] = None
                binding["receiptSha256"] = None
                binding["elapsedMilliseconds"] = 0
            evidence["accessibility"]["status"] = "NOT_RUN"
            for check in evidence["accessibility"]["checks"]:
                check["status"] = "NOT_RUN"
            evidence["privacy"]["status"] = "NOT_RUN"
            evidence["privacy"]["scannedEvidenceBindingIds"] = []
            evidence["validationSessions"] = []
            evidence["verification"]["packagedMacos"] = "NOT_RUN"
            evidence["verification"]["packagedProductFlows"] = "NOT_RUN"
            evidence["verification"]["accessibility"] = "NOT_RUN"
            evidence["verification"]["rootDevCheck"] = "BLOCKED_HEAD_BASELINE"
            evidence["blockers"] = [
                "ROOT_DEV_CHECK_HEAD_BASELINE",
                "PACKAGED_CLOSURE_NOT_CAPTURED",
                "ACCESSIBILITY_MANUAL_NOT_RUN",
            ]

        self._mutate(block)
        with self.assertRaisesRegex(ValueError, "blocked"):
            self._validate()
        self.assertEqual("BLOCKED", self._validate(allow_blocked=True)["status"])

    def test_capability_set_is_exact(self) -> None:
        self.scope["capabilities"].pop()
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "capabilit"):
            self._validate()

    def test_unknown_top_level_field_is_rejected(self) -> None:
        self.evidence["surprise"] = True
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "field"):
            self._validate()

    def test_pass_requires_complete_artifacts(self) -> None:
        self.evidence["artifacts"]["status"] = "NOT_RUN"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "artifact"):
            self._validate()

    def test_scope_evidence_hash_drift_is_rejected(self) -> None:
        self.scope["targets"]["macos"]["evidence"]["sha256"] = "0" * 64
        self.scope_path.write_text(json.dumps(self.scope), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "evidence hash"):
            self._validate()

    def test_every_artifact_class_is_hash_bound(self) -> None:
        for identifier in (
            "app-executable",
            "native-helper",
            "asr-worker",
            "caption-worker",
            "onnxruntime",
            "asr-model",
            "worker-manifest",
        ):
            with self.subTest(identifier=identifier):
                evidence = copy.deepcopy(self.evidence)
                binding = next(
                    item
                    for item in evidence["artifacts"]["bindings"]
                    if item["id"] == identifier
                )
                binding["sha256"] = "0" * 64
                self.evidence = evidence
                self._write_documents()
                with self.assertRaisesRegex(ValueError, "hash"):
                    self._validate()
                self.evidence = self._valid_evidence()

    def test_unsafe_and_symlink_artifact_paths_are_rejected(self) -> None:
        binding = self.evidence["artifacts"]["bindings"][0]
        binding["path"] = "../escape"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self._validate()

        self.evidence = self._valid_evidence()
        link = self.root / "linked-helper"
        link.symlink_to(
            self.bundle
            / "Contents/Resources/native/macos/bin/desktop_macos_native_helper"
        )
        helper = next(
            item
            for item in self.evidence["artifacts"]["bindings"]
            if item["id"] == "native-helper"
        )
        helper["path"] = "linked-helper"
        helper["sha256"] = _sha256(link)
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "symlink"):
            self._validate()

    def test_packaged_runtime_cannot_use_dev_or_flutter_paths(self) -> None:
        for field in (
            "viteDevelopmentServerUsed",
            "repositoryPathUsedByPackagedApp",
            "flutterBuildOutputUsed",
            "pubCacheUsed",
        ):
            with self.subTest(field=field):
                evidence = copy.deepcopy(self.evidence)
                evidence["artifacts"]["runtimeIsolation"][field] = True
                self.evidence = evidence
                self._write_documents()
                with self.assertRaisesRegex(ValueError, "packaged runtime"):
                    self._validate()
                self.evidence = self._valid_evidence()

    def test_manual_evidence_must_be_completed_bounded_and_bound(self) -> None:
        binding = next(
            item
            for item in self.evidence["evidenceBindings"]
            if item["id"] == "manual-voiceover"
        )
        for field, value in (
            ("status", "NOT_RUN"),
            ("maximumMinutes", 31),
            ("packageManifestSha256", "0" * 64),
            ("targetFingerprintSha256", "0" * 64),
        ):
            with self.subTest(field=field):
                mutated = copy.deepcopy(self.evidence)
                target = next(
                    item
                    for item in mutated["evidenceBindings"]
                    if item["id"] == "manual-voiceover"
                )
                target[field] = value
                self.evidence = mutated
                self._write_documents()
                with self.assertRaisesRegex(ValueError, "manual"):
                    self._validate()
                self.evidence = self._valid_evidence()

    def test_accessibility_check_set_is_exact(self) -> None:
        self.evidence["accessibility"]["checks"].pop()
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "accessibility"):
            self._validate()

    def test_privacy_findings_and_sensitive_values_are_rejected(self) -> None:
        for field in (
            "sensitiveKeyDetected",
            "fullSensitivePathDetected",
            "repositoryPathDetected",
            "rawAudioOrTranscriptDetected",
            "reusableTokenDetected",
            "secretCanaryDetected",
        ):
            with self.subTest(field=field):
                evidence = copy.deepcopy(self.evidence)
                evidence["privacy"][field] = True
                self.evidence = evidence
                self._write_documents()
                with self.assertRaisesRegex(ValueError, "privacy"):
                    self._validate()
                self.evidence = self._valid_evidence()

        self.evidence["artifacts"]["bundle"]["path"] = "/Users/private/app"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "unsafe|sensitive"):
            self._validate()

        self.evidence = self._valid_evidence()
        self.evidence["artifacts"]["signing"]["credentialBase64"] = "YWFhYQ=="
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "privacy-sensitive"):
            self._validate()

    def test_validation_sessions_are_bounded_to_thirty_minutes(self) -> None:
        session = self.evidence["validationSessions"][0]
        session["elapsedMilliseconds"] = 1_800_001
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "30 minutes"):
            self._validate()

    def test_development_only_release_exclusions_cannot_drift(self) -> None:
        self.scope["releaseExclusions"]["productionNotarization"] = True
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "DEVELOPMENT_ONLY"):
            self._validate()

    def test_source_manifest_and_lock_are_hash_bound(self) -> None:
        self.evidence["source"]["dependencyLock"]["sha256"] = "0" * 64
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "dependency lock hash"):
            self._validate()

    def test_frozen_baseline_and_files_are_hash_bound(self) -> None:
        self.evidence["referenceBaseline"]["sha256"] = "0" * 64
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "baseline hash"):
            self._validate()

        self.evidence = self._valid_evidence()
        self.evidence["referenceBaseline"]["frozenFiles"][0]["sha256"] = (
            "0" * 64
        )
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "frozen reference"):
            self._validate()

    def test_reference_dispositions_fail_closed(self) -> None:
        self.evidence["referenceBaseline"]["laterChanges"] = [
            {
                "flutterRevision": "1" * 40,
                "changedCapabilityIds": ["shell.navigation"],
                "disposition": "deferred-and-parity-blocked",
                "rationale": "REFERENCE_CHANGE_DEFERRED",
                "electronEvidence": [],
            }
        ]
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "reference change"):
            self._validate()

    def test_windows_cannot_inherit_or_claim_pass_at_u12(self) -> None:
        self.scope["targets"]["windows"]["status"] = "PASS"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "Windows"):
            self._validate()
        self.scope = self._valid_scope(self.evidence)
        self.scope["targets"]["windows"]["inheritsMacosPass"] = True
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "inherit"):
            self._validate()

    def test_pass_rejects_blocked_root_dev_check(self) -> None:
        self.evidence["verification"]["rootDevCheck"] = "BLOCKED_HEAD_BASELINE"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "root dev_check"):
            self._validate()

    def test_pass_requires_hash_bound_execution_receipt(self) -> None:
        binding = self.evidence["evidenceBindings"][0]
        binding["receiptPath"] = None
        binding["receiptSha256"] = None
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "execution receipt"):
            self._validate()

    def test_sensitive_execution_receipt_is_rejected(self) -> None:
        binding = self.evidence["evidenceBindings"][0]
        receipt_path = self.root / binding["receiptPath"]
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["secret"] = "SECRET_CANARY"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        binding["receiptSha256"] = _sha256(receipt_path)
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "privacy-sensitive"):
            self._validate()

    def test_artifact_identity_and_bundle_location_are_exact(self) -> None:
        helper = next(
            item
            for item in self.evidence["artifacts"]["bindings"]
            if item["id"] == "native-helper"
        )
        outside = self._write("outside-helper", b"helper")
        helper["path"] = outside.relative_to(self.root).as_posix()
        helper["sha256"] = _sha256(outside)
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "package location"):
            self._validate()

    def test_capability_and_accessibility_bindings_are_exact(self) -> None:
        self.scope["capabilities"][0]["evidenceBindingIds"] = [
            "gate-companion.transfer"
        ]
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "binding identity"):
            self._validate()

        self.scope = self._valid_scope(self.evidence)
        voiceover = next(
            item
            for item in self.evidence["accessibility"]["checks"]
            if item["id"] == "voiceover"
        )
        voiceover["evidenceBindingIds"] = []
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "accessibility evidence binding"):
            self._validate()

    def test_blocked_evidence_requires_blocked_disposition(self) -> None:
        self.scope["targets"]["macos"].update(
            status="BLOCKED",
            closureDisposition="MACOS_ELECTRON_CLOSURE_BLOCKED",
        )
        self.scope["targets"]["windows"]["status"] = "BLOCKED_BY_MACOS_CLOSURE"
        for capability in self.scope["capabilities"]:
            capability["status"] = "BLOCKED"
        self.evidence["status"] = "BLOCKED"
        self.evidence["disposition"] = "MACOS_ELECTRON_CLOSED_FOR_WINDOWS_ENTRY"
        self.evidence["blockers"] = ["NOT_CAPTURED"]
        for capability in self.evidence["capabilityEvidence"]:
            capability["status"] = "BLOCKED"
        self._write_documents()
        with self.assertRaisesRegex(ValueError, "blocked disposition"):
            self._validate(allow_blocked=True)

    def test_live_source_binding_rejects_committed_dirty_and_untracked_drift(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
        relevant = repository / RELEVANT_SOURCE_PATHS[0] / "source.ts"
        relevant.parent.mkdir(parents=True)
        relevant.write_text("one\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=repository, check=True)
        revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
        tree = subprocess.run(["git", "show", "-s", "--format=%T", revision], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
        source = {
            "revision": revision,
            "tree": tree,
            "relevantSourceSha256": _relevant_source_sha256(repository, revision),
        }
        _validate_live_source_binding(repository, source)

        relevant.write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "dirty"):
            _validate_live_source_binding(repository, source)
        relevant.write_text("one\n", encoding="utf-8")

        untracked = relevant.parent / "untracked.ts"
        untracked.write_text("new\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "untracked"):
            _validate_live_source_binding(repository, source)
        untracked.unlink()

        relevant.write_text("two\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        subprocess.run(["git", "commit", "-qm", "later"], cwd=repository, check=True)
        with self.assertRaisesRegex(ValueError, "changed after"):
            _validate_live_source_binding(repository, source)

    def test_closure_script_disables_capture_initialize_only_bypass(self) -> None:
        script = (ROOT / "tool/check_electron_desktop.sh").read_text(encoding="utf-8")
        self.assertIn(
            "RUN_PACKAGED_CAPTURE_INITIALIZE_ONLY=0 RUN_PACKAGED_CAPTURE_SMOKE=1",
            script,
        )


if __name__ == "__main__":
    unittest.main()
