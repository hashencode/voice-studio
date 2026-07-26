from __future__ import annotations

import copy
import hashlib
import io
import json
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from aggregate_results import AggregationError, aggregate_candidate
from development_matrix import (
    DevelopmentMatrixError,
    build_development_schedule,
    execute_development_matrix,
    required_model_roles,
    validate_candidate_assets,
    validate_prepared_fixture_pack,
    validate_runtime_identity,
    validate_target_fingerprint,
)


ROOT = Path(__file__).resolve().parent


class DevelopmentMatrixTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads((ROOT / "macos_contract.json").read_text())
        self.registry = json.loads((ROOT / "candidates.json").read_text())
        self.fixtures = json.loads((ROOT / "fixtures.json").read_text())

    def test_current_unfrozen_development_pack_fails_before_scheduling(self) -> None:
        with self.assertRaisesRegex(
            DevelopmentMatrixError,
            "development fixture is not frozen",
        ):
            build_development_schedule(
                self.contract,
                self.registry,
                self.fixtures,
            )

    def test_schedule_contains_only_four_admitted_sherpa_candidates(self) -> None:
        fixtures = self._frozen_development_fixtures()

        schedule = build_development_schedule(
            self.contract,
            self.registry,
            fixtures,
        )

        candidate_ids = {item["candidateId"] for item in schedule}
        self.assertEqual(
            candidate_ids,
            {
                "sherpa-streaming-zipformer-zh-14m-2023-02-23",
                "sherpa-onnx-paraformer-zh-int8-2025-10-07",
                "sherpa-onnx-paraformer-zh-2024-03-09",
                "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
            },
        )
        self.assertEqual(len(schedule), 4 * 2 * 4 * 6)
        self.assertEqual(
            {item["profileId"] for item in schedule},
            {"recommended", "fixed-resource"},
        )
        self.assertEqual(sum(item["warmup"] for item in schedule), 4 * 2 * 4)
        self.assertTrue(all(item["rankEligible"] for item in schedule))
        self.assertNotIn(
            "native-funasr-1.3.22-paraformer-vad-punctuation",
            candidate_ids,
        )

    def test_model_roles_are_exact_and_family_specific(self) -> None:
        self.assertEqual(
            required_model_roles("streaming_zipformer_transducer"),
            ("decoder", "encoder", "joiner", "tokens"),
        )
        self.assertEqual(
            required_model_roles("offline_paraformer"),
            ("model", "tokens"),
        )
        self.assertEqual(
            required_model_roles("firered_asr_ctc"),
            ("model", "tokens"),
        )
        with self.assertRaisesRegex(DevelopmentMatrixError, "unsupported family"):
            required_model_roles("funasr_nano")

    def test_target_fingerprint_must_match_frozen_m4_contract(self) -> None:
        fingerprint = {
            "operatingSystem": "macos",
            "operatingSystemVersion": "15.7.5",
            "architecture": "arm64",
            "cpuModel": "Apple M4",
            "logicalCpuCount": 10,
            "memoryBytes": 17179869184,
        }
        validate_target_fingerprint(self.contract, fingerprint)

        fingerprint["cpuModel"] = "Apple M2"
        with self.assertRaisesRegex(DevelopmentMatrixError, "CPU model"):
            validate_target_fingerprint(self.contract, fingerprint)

    def test_runtime_identity_binds_package_payload_and_loaded_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package_root = root / "package"
            package_runtime = package_root / "macos/libsherpa-onnx-c-api.dylib"
            loaded_runtime = root / "loaded/libsherpa-onnx-c-api.dylib"
            package_runtime.parent.mkdir(parents=True)
            loaded_runtime.parent.mkdir(parents=True)
            payload = b"runtime"
            package_runtime.write_bytes(payload)
            loaded_runtime.write_bytes(payload)
            package_config = root / ".dart_tool/package_config.json"
            package_config.parent.mkdir()
            package_config.write_text(
                json.dumps(
                    {
                        "configVersion": 2,
                        "packages": [
                            {
                                "name": "sherpa_onnx_macos",
                                "rootUri": package_root.as_uri(),
                                "packageUri": "lib/",
                                "languageVersion": "3.0",
                            }
                        ],
                    }
                )
            )
            digest = hashlib.sha256(payload).hexdigest()

            self.assertEqual(
                validate_runtime_identity(root, loaded_runtime, digest),
                digest,
            )

            package_runtime.write_bytes(b"drift")
            with self.assertRaisesRegex(DevelopmentMatrixError, "package payload"):
                validate_runtime_identity(root, loaded_runtime, digest)

    def test_prepared_fixture_pack_is_hash_bound_and_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest, prepared_root = self._prepared_fixture_pack(Path(temporary))

            resolved = validate_prepared_fixture_pack(
                prepared_root,
                manifest,
            )

            self.assertEqual(len(resolved), 4)
            self.assertTrue(
                all(value["audio"].is_file() for value in resolved.values())
            )
            fixture_id = "development-common-voice-clean"
            resolved[fixture_id]["reference"].write_text("drift")
            with self.assertRaisesRegex(DevelopmentMatrixError, "hash mismatch"):
                validate_prepared_fixture_pack(prepared_root, manifest)

    def test_candidate_assets_resolve_only_required_hash_pinned_roles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            candidate = copy.deepcopy(self.registry["candidates"][0])
            active = Path(temporary) / candidate["candidateId"] / "active"
            files = active / "files"
            files.mkdir(parents=True)
            artifacts = {
                artifact["componentId"]: artifact
                for artifact in candidate["artifacts"]
            }
            components = []
            file_hashes = {}
            for role in required_model_roles(candidate["family"]):
                payload = role.encode()
                digest = hashlib.sha256(payload).hexdigest()
                artifacts[role]["sha256"] = digest
                (files / role).write_bytes(payload)
                components.append(
                    {
                        "componentId": role,
                        "fileRole": artifacts[role]["fileRole"],
                        "bytes": len(payload),
                        "sha256": digest,
                    }
                )
                file_hashes[f"files/{role}"] = digest
            (active / "asset_manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "candidateId": candidate["candidateId"],
                        "licenseDisposition": "ACCEPTED_FOR_BENCHMARK",
                        "fileCount": len(components),
                        "extractedBytes": sum(item["bytes"] for item in components),
                        "extractedTreeSha256": hashlib.sha256(
                            "\n".join(
                                (
                                    f"{item['componentId']}\0"
                                    f"{item['bytes']}\0{item['sha256']}"
                                )
                                for item in sorted(
                                    components,
                                    key=lambda value: value["componentId"],
                                )
                            ).encode()
                        ).hexdigest(),
                        "components": components,
                        "fileSha256": file_hashes,
                        "sourcePathsPublished": False,
                    }
                )
            )

            resolved = validate_candidate_assets(Path(temporary), candidate)

            self.assertEqual(
                set(resolved),
                set(required_model_roles(candidate["family"])),
            )
            (files / "encoder").write_bytes(b"drift")
            with self.assertRaisesRegex(DevelopmentMatrixError, "hash mismatch"):
                validate_candidate_assets(Path(temporary), candidate)

    def test_execution_builds_sandbox_requests_and_aggregates_only_after_completion(
        self,
    ) -> None:
        repository_root = ROOT.parents[2]
        build_root = repository_root / "build/desktop_asr_comparison"
        build_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="development-matrix-test-",
            dir=build_root,
        ) as temporary:
            temporary_root = Path(temporary)
            audio = temporary_root / "development.wav"
            reference = temporary_root / "development.txt"
            audio.write_bytes(self._wav_bytes())
            reference.write_text("测试参考")
            candidates = [
                candidate
                for candidate in self.registry["candidates"]
                if candidate["runtimeKind"] == "sherpa_onnx"
                and candidate["admission"]["status"] == "ADMITTED"
            ]
            assets = {}
            for candidate in candidates:
                model_files = {}
                for role in required_model_roles(candidate["family"]):
                    path = temporary_root / candidate["candidateId"] / role
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(f"{candidate['candidateId']}:{role}".encode())
                    model_files[role] = path
                assets[candidate["candidateId"]] = model_files
            tools = temporary_root / "tools"
            runtime = temporary_root / "runtime"
            tools.mkdir()
            runtime.mkdir()
            runtime_inputs = {
                "launcher": tools / "sandboxed_candidate_launcher",
                "worker": tools / "desktop_asr_candidate_worker",
                "processGroupLauncher": tools / "native_process_group_launcher",
                "runtime": runtime / "libsherpa-onnx-c-api.dylib",
            }
            for path in runtime_inputs.values():
                path.write_bytes(path.name.encode())
            schedule = []
            order = 0
            for run_index, warmup in ((0, True), (1, False)):
                for candidate in candidates:
                    for profile_id in ("recommended", "fixed-resource"):
                        profile = candidate["profiles"][profile_id]
                        schedule.append(
                            {
                                "candidateId": candidate["candidateId"],
                                "family": candidate["family"],
                                "laneId": candidate["runtimeLaneIds"][0],
                                "profileId": profile_id,
                                "fixtureId": "development-test",
                                "scenario": "clean_near_field_mandarin",
                                "scorecard": profile["scorecard"],
                                "rankEligible": True,
                                "observationSource": "m4_development_matrix",
                                "pacingPolicy": profile["effectiveConfig"].get(
                                    "pacingPolicy",
                                    "unpaced",
                                ),
                                "runIndex": run_index,
                                "warmup": warmup,
                                "scheduleOrder": order,
                            }
                        )
                        order += 1
            calls = []

            def fake_execute(**kwargs):
                calls.append(kwargs)
                specification = kwargs["specification"]
                request = kwargs["request"]
                self.assertTrue(
                    Path(request["workerRequest"]["sourcePath"]).is_file()
                )
                self.assertEqual(
                    request["workerRequest"]["candidateId"],
                    specification["candidateId"],
                )
                return {
                    "runId": f"run-{specification['scheduleOrder']:04d}",
                    "complete": True,
                    "disposition": "SUCCESS",
                    "candidateId": specification["candidateId"],
                    "laneId": specification["laneId"],
                    "profileId": specification["profileId"],
                    "fixtureId": specification["fixtureId"],
                    "scenario": specification["scenario"],
                    "scorecard": specification["scorecard"],
                    "runIndex": specification["runIndex"],
                    "warmup": specification["warmup"],
                    "scheduleOrder": specification["scheduleOrder"],
                    "rawOutputSha256": hashlib.sha256(
                        (
                            specification["candidateId"]
                            + specification["profileId"]
                        ).encode()
                    ).hexdigest(),
                    "metrics": {
                        "cer": 0.1,
                        "wer": 0.1,
                        "terminologyRecall": None,
                        "numericEventAccuracy": None,
                        "hallucinationLexicalCharactersPerMinute": None,
                        "rtf": 0.1,
                        "loadMilliseconds": 1.0,
                        "decodeMilliseconds": 100.0,
                        "absolutePeakRssBytes": 200,
                        "incrementalPeakRssBytes": 100,
                        "retainedRssBytesAfterUnload": 50,
                    },
                }

            context = {
                "root": repository_root,
                "comparisonRoot": ROOT,
                "contract": self.contract,
                "registry": self.registry,
                "schedule": schedule,
                "fixtures": {
                    "development-test": {
                        "audio": audio,
                        "reference": reference,
                    }
                },
                "assets": assets,
                "candidateIndex": {
                    candidate["candidateId"]: candidate
                    for candidate in self.registry["candidates"]
                },
                "runtimeInputs": runtime_inputs,
                "toolsRoot": tools,
                "runtimeRoot": runtime,
                "targetFingerprint": {
                    "operatingSystemVersion": "15.7.5",
                    "architecture": "arm64",
                    "cpuModel": "Apple M4",
                    "logicalCpuCount": 10,
                    "memoryBytes": 17179869184,
                    "runtimeId": self.contract["runtimeLanes"][0]["laneId"],
                    "runtimeVersion": "1.13.4",
                    "runtimeSha256": hashlib.sha256(
                        runtime_inputs["runtime"].read_bytes()
                    ).hexdigest(),
                },
            }
            output = temporary_root / "output"

            aggregation_calls = 0

            def fail_second_aggregate(selected):
                nonlocal aggregation_calls
                aggregation_calls += 1
                if aggregation_calls == 2:
                    raise AggregationError("injected aggregate failure")
                return aggregate_candidate(selected)

            failed_output = temporary_root / "failed-output"
            with (
                patch(
                    "development_matrix.aggregate_candidate",
                    side_effect=fail_second_aggregate,
                ),
                self.assertRaisesRegex(
                    AggregationError,
                    "injected aggregate failure",
                ),
            ):
                execute_development_matrix(
                    context,
                    output_root=failed_output,
                    timeout_seconds=10,
                    execute=fake_execute,
                )
            self.assertFalse((failed_output / "aggregates").exists())
            self.assertFalse(
                (failed_output / "development-matrix-result.json").exists()
            )
            calls.clear()

            result = execute_development_matrix(
                context,
                output_root=output,
                timeout_seconds=10,
                execute=fake_execute,
            )

            self.assertEqual(len(calls), 16)
            self.assertEqual(result["scheduledRunCount"], 16)
            self.assertEqual(result["completedRunCount"], 16)
            self.assertEqual(result["warmupRunCount"], 8)
            self.assertEqual(result["measuredRunCount"], 8)
            self.assertEqual(len(result["comparisons"]), 6)
            self.assertFalse(result["rankEligible"])
            self.assertFalse(result["heldOutDecoded"])
            self.assertTrue(result["developmentFreezeReady"])
            self.assertFalse(any((output / "jobs").iterdir()))
            self.assertTrue(
                (output / "development-matrix-result.json").is_file()
            )

    def _frozen_development_fixtures(self) -> dict:
        manifest = copy.deepcopy(self.fixtures)
        for fixture in manifest["fixtures"]:
            if fixture["fixtureRole"] != "development":
                continue
            fixture["freezeState"] = "FROZEN"
            fixture["referenceReview"] = "REVIEWED"
            fixture["licenseOrConsent"] = "REVIEWED_FOR_LOCAL_BENCHMARK"
            if fixture["scenario"] == "dialect_accent":
                fixture["varietyReview"] = "REVIEWED"
            fixture["audio"]["sha256"] = "a" * 64
            fixture["audio"]["bytes"] = 32044
            fixture["audio"]["durationSeconds"] = 1.0
            fixture["reference"]["sha256"] = "b" * 64
            fixture["reference"]["bytes"] = 1
        return manifest

    def _prepared_fixture_pack(self, root: Path) -> tuple[dict, Path]:
        manifest = self._frozen_development_fixtures()
        prepared_root = root / "development-active"
        fixture_root = prepared_root / "fixtures"
        fixture_root.mkdir(parents=True)
        file_hashes = {}
        files = []
        for fixture in manifest["fixtures"]:
            if fixture["fixtureRole"] != "development":
                continue
            audio = self._wav_bytes()
            reference = fixture["fixtureId"].encode()
            fixture["audio"]["sha256"] = hashlib.sha256(audio).hexdigest()
            fixture["audio"]["bytes"] = len(audio)
            fixture["audio"]["durationSeconds"] = 1.0
            fixture["reference"]["sha256"] = hashlib.sha256(reference).hexdigest()
            fixture["reference"]["bytes"] = len(reference)
            audio_relative = f"fixtures/{fixture['fixtureId']}.wav"
            reference_relative = f"fixtures/{fixture['fixtureId']}.txt"
            (prepared_root / audio_relative).write_bytes(audio)
            (prepared_root / reference_relative).write_bytes(reference)
            for relative, payload in (
                (audio_relative, audio),
                (reference_relative, reference),
            ):
                files.append(relative)
                file_hashes[relative] = hashlib.sha256(payload).hexdigest()
        (prepared_root / "prepared_manifest.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "fixtureManifestId": manifest["fixtureManifestId"],
                    "mode": "development",
                    "fixtureCount": 4,
                    "files": sorted(files),
                    "fileSha256": {
                        key: file_hashes[key] for key in sorted(file_hashes)
                    },
                }
            )
        )
        return manifest, prepared_root

    @staticmethod
    def _wav_bytes() -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(16000)
            target.writeframes(struct.pack("<16000h", *([0] * 16000)))
        return output.getvalue()


if __name__ == "__main__":
    unittest.main()
