import copy
import hashlib
import json
import unittest
from pathlib import Path

from benchmark.evaluate_speaker_diarization import (
    ManifestError,
    evaluate_probe_evidence,
    evaluate_screening_evidence,
    validate_manifest,
)
from benchmark.speaker_diarization_contract import (
    validate_deferred_evidence_summary,
)


class SpeakerDiarizationManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads(
            Path("benchmark/speaker_diarization_admission_contract.json").read_text(
                encoding="utf-8"
            )
        )
        cls.manifest = json.loads(
            Path("benchmark/speaker_diarization_manifest.json").read_text(encoding="utf-8")
        )

    def test_repository_manifest_is_valid_deferred_evidence(self):
        result = validate_manifest(
            copy.deepcopy(self.manifest),
            copy.deepcopy(self.contract),
        )

        self.assertEqual("DEFERRED_NO_ADMISSIBLE_CANDIDATE", result["status"])
        self.assertFalse(result["verified"])
        self.assertFalse(result["eligibleForProductization"])
        self.assertFalse(result["productAvailable"])
        self.assertEqual(
            ["FUNCTIONAL", "RESOURCE", "NO_ADMISSIBLE_CANDIDATE"],
            result["failedGates"],
        )

    def test_both_screening_contracts_match_committed_evidence(self):
        cases = (
            (
                "benchmark/speaker_diarization_current_screening_contract.json",
                "benchmark/evidence/speaker_diarization/current-functional-screen.json",
            ),
            (
                "benchmark/speaker_diarization_admission_contract.json",
                "benchmark/evidence/speaker_diarization/functional.json",
            ),
        )
        for contract_path, evidence_path in cases:
            contract_bytes = Path(contract_path).read_bytes()
            contract = json.loads(contract_bytes)
            evidence = json.loads(Path(evidence_path).read_text(encoding="utf-8"))
            self.assertEqual(contract["contractId"], evidence["contractId"])
            self.assertEqual(contract["candidate"]["id"], evidence["candidateId"])
            self.assertEqual(
                hashlib.sha256(contract_bytes).hexdigest(),
                evidence["contractSha256"],
            )

    def test_gate_script_evaluates_screen_before_resource_probe(self):
        script = Path("benchmark/run_speaker_diarization_gate.sh").read_text(
            encoding="utf-8"
        )
        decision_check = script.index('screening_decision="$(')
        resource_probe = script.index(
            "SpeakerDiarizationResourceGateTest"
            "#runBoundedOneHundredTwentyMinuteResourceProbe"
        )

        self.assertLess(decision_check, resource_probe)
        self.assertIn(
            'if [[ "$screening_decision" != "ADVANCE_TO_FINAL_GATE" ]]',
            script,
        )
        self.assertIn(
            'SCREENING_CONTRACT="$ROOT/benchmark/'
            'speaker_diarization_current_screening_contract.json"',
            script,
        )

    def test_repository_summary_is_derived_from_committed_evidence(self):
        evidence_by_role = {
            item["role"]: json.loads(Path(item["path"]).read_text(encoding="utf-8"))
            for item in self.manifest["evidenceFiles"]
        }

        validate_deferred_evidence_summary(self.manifest, evidence_by_role)

    def test_summary_rejects_metric_drift_from_evaluation(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["probes"]["fiveMinute"]["der"] = 0.3
        evidence_by_role = {
            item["role"]: json.loads(Path(item["path"]).read_text(encoding="utf-8"))
            for item in manifest["evidenceFiles"]
        }

        with self.assertRaisesRegex(ManifestError, "fiveMinute.der drifted"):
            validate_deferred_evidence_summary(manifest, evidence_by_role)

    def test_verified_rejects_missing_model_identity(self):
        manifest = self._verified_manifest()
        contract = copy.deepcopy(self.contract)
        contract["candidate"]["models"]["segmentation"]["artifactSha256"] = None

        with self.assertRaisesRegex(ManifestError, "segmentation SHA-256 missing"):
            validate_manifest(manifest, contract)

    def test_verified_rejects_missing_license_review(self):
        manifest = self._verified_manifest()
        contract = copy.deepcopy(self.contract)
        contract["candidate"]["models"]["embedding"]["licenseReviewed"] = False

        with self.assertRaisesRegex(ManifestError, "embedding license not reviewed"):
            validate_manifest(manifest, contract)

    def test_verified_rejects_incomplete_functional_probe(self):
        manifest = self._verified_manifest()
        manifest["probes"]["fiveMinute"]["der"] = 0.31

        with self.assertRaisesRegex(ManifestError, "DER above"):
            validate_manifest(manifest, self.contract)

    def test_verified_rejects_incomplete_resource_probe(self):
        manifest = self._verified_manifest()
        manifest["probes"]["oneHundredTwentyMinute"]["incrementalPeakRssMiB"] = 385

        with self.assertRaisesRegex(ManifestError, "RSS above"):
            validate_manifest(manifest, self.contract)

    def test_deferred_rejects_packaged_unadmitted_model(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["productState"]["modelsPackaged"] = True

        with self.assertRaisesRegex(ManifestError, "must not be packaged"):
            validate_manifest(manifest, self.contract)

    def test_reviewed_deferred_model_requires_fixed_artifact_identity(self):
        contract = copy.deepcopy(self.contract)
        contract["candidate"]["models"]["segmentation"]["artifactSha256"] = None

        with self.assertRaisesRegex(ManifestError, "segmentation SHA-256 missing"):
            validate_manifest(self.manifest, contract)

    def test_verified_is_eligible_without_opening_the_product(self):
        result = validate_manifest(self._verified_manifest(), self.contract)

        self.assertEqual("VERIFIED", result["status"])
        self.assertTrue(result["verified"])
        self.assertTrue(result["eligibleForProductization"])
        self.assertFalse(result["productAvailable"])

    def test_verified_rejects_missing_raw_evidence_hash(self):
        manifest = self._verified_manifest()
        manifest["probes"]["fiveMinute"]["evidenceSha256"] = None

        with self.assertRaisesRegex(ManifestError, "5-minute evidence hash missing"):
            validate_manifest(manifest, self.contract)

    def test_verified_rejects_hard_coded_transcript_unchanged(self):
        manifest = self._verified_manifest()
        manifest["probes"]["fiveMinute"].update(
            transcriptSnapshotBeforeSha256=None,
            transcriptSnapshotAfterSha256=None,
            transcriptUnchanged=True,
        )

        with self.assertRaisesRegex(ManifestError, "transcript snapshot hashes missing"):
            validate_manifest(manifest, self.contract)

    def test_verified_rejects_product_opened_by_admission(self):
        manifest = self._verified_manifest()
        manifest["productAvailable"] = True

        with self.assertRaisesRegex(ManifestError, "productAvailable must remain false"):
            validate_manifest(manifest, self.contract)

    def test_v1_manifest_cannot_be_silently_treated_as_v2(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["schemaVersion"] = 1

        with self.assertRaisesRegex(ManifestError, "schemaVersion must be 2"):
            validate_manifest(manifest, self.contract)

    def test_no_candidate_closure_rejects_missing_evidence_file(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["evidenceFiles"].pop()

        with self.assertRaisesRegex(ManifestError, "evidenceFiles are incomplete"):
            validate_manifest(manifest, self.contract)

    def test_contract_rejects_unregistered_frozen_configuration(self):
        contract = copy.deepcopy(self.contract)
        contract["candidate"]["frozenConfiguration"]["numThreads"] = 3

        with self.assertRaisesRegex(ManifestError, "must be preregistered"):
            validate_manifest(self.manifest, contract)

    def test_probe_evidence_reports_resource_gate_after_functional_pass(self):
        generated = {
            "schemaVersion": 2,
            "contractId": self.contract["contractId"],
            "functional": {
                "sha256": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "durationSeconds": 2.2,
                "overlapRegions": [[0.8, 1.2]],
                "silenceRegions": [[2.0, 2.2]],
                "rttmSha256": "unused-by-unit-helper",
            },
            "resource": {
                "sha256": self.contract["fixtures"]["oneHundredTwentyMinute"][
                    "wavSha256"
                ],
                "durationSeconds": 7200,
            },
            "semanticContract": {
                "activityWithoutAttribution": "UNKNOWN",
                "noActivity": "SILENCE",
            },
        }
        five = {
            "schemaVersion": 1,
            **self._evidence_identity("fiveMinute"),
            "device": {
                **self._device(),
                "maximumThermalStatusRaw": 0,
                "maximumThermalStatusName": "none",
            },
            "fixture": {
                "sha256": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "sha256After": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "sampleRate": 16_000,
                "totalSamples": 35_200,
                "consumedSamples": 35_200,
            },
            "transcriptSnapshot": {
                "beforeSha256": "d" * 64,
                "afterSha256": "d" * 64,
            },
            "windows": {
                "planned": 1,
                "processed": 1,
                "finalWindowEndSample": 35_200,
            },
            "timings": self._timings(),
            "semanticIntervals": [
                {
                    "startSample": 0,
                    "endSampleExclusive": 12_800,
                    "kind": "ASSIGNED",
                    "meetingSpeakerKeys": ["speaker_1"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 12_800,
                    "endSampleExclusive": 19_200,
                    "kind": "OVERLAP",
                    "meetingSpeakerKeys": ["speaker_1", "speaker_2"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 19_200,
                    "endSampleExclusive": 32_000,
                    "kind": "ASSIGNED",
                    "meetingSpeakerKeys": ["speaker_2"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 32_000,
                    "endSampleExclusive": 35_200,
                    "kind": "SILENCE",
                    "meetingSpeakerKeys": [],
                    "unknownSpeakerCount": 0,
                },
            ],
            "complete": True,
        }
        resource = {
            **self._evidence_identity("oneHundredTwentyMinute"),
            "fixture": {
                "sha256": self.contract["fixtures"]["oneHundredTwentyMinute"][
                    "wavSha256"
                ],
                "sampleRate": 16_000,
                "totalSamples": 115_200_000,
                "consumedSamples": 115_200_000,
            },
            "windows": {
                "planned": 288,
                "processed": 288,
                "finalWindowEndSample": 115_200_000,
                "retainedFinalizedIntervalCount": 0,
            },
            "memory": {
                "baselinePssKiB": 100_000,
                "peakPssKiB": 500_000,
            },
            "device": {
                **self._device(),
                "maximumThermalStatusRaw": 0,
                "maximumThermalStatusName": "none",
            },
            "elapsedMs": 7_200_000,
            "completed": False,
            "oom": False,
            "anr": False,
            "complete": True,
        }
        rttm = (
            "SPEAKER speaker-functional-5m 1 0.0 1.2 <NA> <NA> "
            "speaker_1 <NA> <NA>\n"
            "SPEAKER speaker-functional-5m 1 0.8 1.2 <NA> <NA> "
            "speaker_2 <NA> <NA>\n"
        )

        result = evaluate_probe_evidence(
            self.manifest,
            self.contract,
            generated,
            five,
            resource,
            rttm,
            functional_evidence_sha256="1" * 64,
            resource_evidence_sha256="2" * 64,
        )

        self.assertEqual("PASS", result["fiveMinute"]["status"])
        self.assertEqual(0.0, result["fiveMinute"]["der"])
        self.assertEqual("FAIL", result["oneHundredTwentyMinute"]["status"])
        self.assertEqual("DEFERRED_RESOURCE_GATE", result["status"])

    def test_probe_evidence_rejects_hard_coded_transcript_boolean(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        five.pop("transcriptSnapshot")
        five["transcriptUnchanged"] = True

        with self.assertRaisesRegex(ManifestError, "transcriptUnchanged"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_missing_resource_baseline(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        resource["memory"].pop("baselinePssKiB")

        with self.assertRaisesRegex(ManifestError, "baseline PSS"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_thermal_name_drift(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        resource["device"]["maximumThermalStatusName"] = "severe"

        with self.assertRaisesRegex(ManifestError, "thermal status mismatch"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_missing_tail_completion(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        resource["windows"]["finalWindowEndSample"] -= 1

        with self.assertRaisesRegex(ManifestError, "final window"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_configuration_drift(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        five["configuration"]["numThreads"] = 3

        with self.assertRaisesRegex(ManifestError, "configuration does not match"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_embedding_payload(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        five["semanticIntervals"][0]["embedding"] = [0.1, 0.2]

        with self.assertRaisesRegex(ManifestError, "forbidden evidence field: embedding"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_audio_payload(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        resource["audio"] = "base64-data"

        with self.assertRaisesRegex(ManifestError, "forbidden evidence field: audio"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_probe_evidence_rejects_absolute_path(self):
        generated, five, resource, rttm = self._passing_probe_inputs()
        resource["device"]["buildFingerprint"] = "/data/local/tmp/fixture.wav"

        with self.assertRaisesRegex(ManifestError, "contains an absolute path"):
            evaluate_probe_evidence(
                self.manifest,
                self.contract,
                generated,
                five,
                resource,
                rttm,
                functional_evidence_sha256="1" * 64,
                resource_evidence_sha256="2" * 64,
            )

    def test_dual_probe_pass_returns_verified_but_product_closed(self):
        generated, five, resource, rttm = self._passing_probe_inputs()

        result = evaluate_probe_evidence(
            self.manifest,
            self.contract,
            generated,
            five,
            resource,
            rttm,
            functional_evidence_sha256="1" * 64,
            resource_evidence_sha256="2" * 64,
        )

        self.assertEqual("VERIFIED", result["status"])
        self.assertTrue(result["eligibleForProductization"])
        self.assertFalse(result["productAvailable"])
        self.assertEqual([], result["failedGates"])

    def test_screening_projects_initialization_only_once(self):
        generated, five, _, rttm = self._passing_probe_inputs()
        five["timings"].update(initializationMs=60_000, totalMs=60_100)

        result = evaluate_screening_evidence(
            self.manifest,
            self.contract,
            generated,
            five,
            rttm,
            functional_evidence_sha256="1" * 64,
        )

        projection = result["projectedOneHundredTwentyMinute"]
        self.assertEqual(60_000, projection["initializationMsChargedOnce"])
        expected_elapsed_ms = 60_000 + 100 * 7_200 / 2.2
        self.assertAlmostEqual(expected_elapsed_ms, projection["projectedElapsedMs"])
        self.assertAlmostEqual(
            expected_elapsed_ms / 7_200_000,
            projection["projectedRtf"],
        )
        self.assertEqual("ADVANCE_TO_FINAL_GATE", result["decision"])

    def test_screening_rejects_projected_rtf_above_threshold(self):
        generated, five, _, rttm = self._passing_probe_inputs()
        five["timings"].update(initializationMs=1_000, totalMs=220_001)

        result = evaluate_screening_evidence(
            self.manifest,
            self.contract,
            generated,
            five,
            rttm,
            functional_evidence_sha256="1" * 64,
        )

        self.assertEqual("REJECT_CURRENT_CANDIDATE", result["decision"])
        self.assertEqual(["PROJECTED_RTF"], result["failedGates"])

    def test_resource_gate_manifest_accepts_functional_pass_and_resource_fail(self):
        manifest = self._verified_manifest()
        manifest.update(
            status="DEFERRED_RESOURCE_GATE",
            verified=False,
            eligibleForProductization=False,
            failedGates=["RESOURCE"],
            reason="120-minute resource probe failed",
        )
        manifest["probes"]["fiveMinute"]["reason"] = "functional probe passed"
        manifest["probes"]["oneHundredTwentyMinute"].update(
            status="FAIL",
            reason="resource threshold exceeded",
            completed=False,
        )

        result = validate_manifest(manifest, self.contract)

        self.assertEqual("DEFERRED_RESOURCE_GATE", result["status"])
        self.assertFalse(result["eligibleForProductization"])
        self.assertEqual(["RESOURCE"], result["failedGates"])

    def test_thirty_minute_probe_cannot_be_invented(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["probes"]["thirtyMinute"]["status"] = "PASS"

        with self.assertRaisesRegex(ManifestError, "30-minute"):
            validate_manifest(manifest, self.contract)

    def _verified_manifest(self):
        manifest = copy.deepcopy(self.manifest)
        manifest.update(
            status="VERIFIED",
            verified=True,
            eligibleForProductization=True,
            productAvailable=False,
            failedGates=[],
            reason=None,
            evaluationEvidenceSha256="d" * 64,
        )
        manifest["productState"]["modelsPackaged"] = False
        manifest["probes"]["fiveMinute"].update(
            status="PASS",
            reason=None,
            device="test-device",
            build="test-build",
            fixtureSha256=self.contract["fixtures"]["fiveMinute"]["wavSha256"],
            evidenceSha256="e" * 64,
            annotatedSpeechCoverage=0.8,
            der=0.3,
            orderedInBoundsTurns=True,
            overlapRepresented=True,
            noSpeakerInPreregisteredSilence=True,
            meetingGlobalSpeakerKeys=True,
            transcriptSnapshotBeforeSha256="1" * 64,
            transcriptSnapshotAfterSha256="1" * 64,
        )
        manifest["probes"]["oneHundredTwentyMinute"].update(
            status="PASS",
            reason=None,
            device="test-device",
            build="test-build",
            fixtureSha256=self.contract["fixtures"]["oneHundredTwentyMinute"][
                "wavSha256"
            ],
            evidenceSha256="f" * 64,
            completed=True,
            oom=False,
            anr=False,
            rtf=0.5,
            incrementalPeakRssMiB=384,
            maximumThermalStatus="moderate",
        )
        return manifest

    def _evidence_identity(self, probe):
        return {
            "schemaVersion": 2,
            "source": "physical_android_instrumentation",
            "probe": probe,
            "contractId": self.contract["contractId"],
            "contractSha256": self.manifest["contractSha256"],
            "candidateId": self.contract["candidate"]["id"],
            "configuration": {
                "windowSamples": 480_000,
                "overlapSamples": 80_000,
                "numThreads": 2,
                "reconciliationThreshold": 0.8,
            },
        }

    def _device(self):
        return {
            "manufacturer": "Xiaomi",
            "model": "M2102J2SC",
            "sdkInt": 33,
            "buildFingerprint": "test-build",
        }

    def _passing_probe_inputs(self):
        generated = {
            "schemaVersion": 2,
            "contractId": self.contract["contractId"],
            "functional": {
                "sha256": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "durationSeconds": 2.2,
                "overlapRegions": [[0.8, 1.2]],
                "silenceRegions": [[2.0, 2.2]],
                "rttmSha256": "unused-by-unit-helper",
            },
            "resource": {
                "sha256": self.contract["fixtures"]["oneHundredTwentyMinute"][
                    "wavSha256"
                ],
                "durationSeconds": 7200,
            },
            "semanticContract": {
                "activityWithoutAttribution": "UNKNOWN",
                "noActivity": "SILENCE",
            },
        }
        five = {
            **self._evidence_identity("fiveMinute"),
            "device": {
                **self._device(),
                "maximumThermalStatusRaw": 0,
                "maximumThermalStatusName": "none",
            },
            "fixture": {
                "sha256": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "sha256After": self.contract["fixtures"]["fiveMinute"]["wavSha256"],
                "sampleRate": 16_000,
                "totalSamples": 35_200,
                "consumedSamples": 35_200,
            },
            "transcriptSnapshot": {
                "beforeSha256": "d" * 64,
                "afterSha256": "d" * 64,
            },
            "windows": {
                "planned": 1,
                "processed": 1,
                "finalWindowEndSample": 35_200,
            },
            "timings": self._timings(),
            "semanticIntervals": [
                {
                    "startSample": 0,
                    "endSampleExclusive": 12_800,
                    "kind": "ASSIGNED",
                    "meetingSpeakerKeys": ["speaker_1"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 12_800,
                    "endSampleExclusive": 19_200,
                    "kind": "OVERLAP",
                    "meetingSpeakerKeys": ["speaker_1", "speaker_2"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 19_200,
                    "endSampleExclusive": 32_000,
                    "kind": "ASSIGNED",
                    "meetingSpeakerKeys": ["speaker_2"],
                    "unknownSpeakerCount": 0,
                },
                {
                    "startSample": 32_000,
                    "endSampleExclusive": 35_200,
                    "kind": "SILENCE",
                    "meetingSpeakerKeys": [],
                    "unknownSpeakerCount": 0,
                },
            ],
            "complete": True,
        }
        resource = {
            **self._evidence_identity("oneHundredTwentyMinute"),
            "device": {
                **self._device(),
                "maximumThermalStatusRaw": 0,
                "maximumThermalStatusName": "none",
            },
            "fixture": {
                "sha256": self.contract["fixtures"]["oneHundredTwentyMinute"][
                    "wavSha256"
                ],
                "sampleRate": 16_000,
                "totalSamples": 115_200_000,
                "consumedSamples": 115_200_000,
            },
            "windows": {
                "planned": 288,
                "processed": 288,
                "finalWindowEndSample": 115_200_000,
                "retainedFinalizedIntervalCount": 0,
            },
            "memory": {
                "baselinePssKiB": 100_000,
                "peakPssKiB": 200_000,
            },
            "elapsedMs": 3_000_000,
            "completed": True,
            "oom": False,
            "anr": False,
            "complete": True,
        }
        rttm = (
            "SPEAKER speaker-functional-5m 1 0.0 1.2 <NA> <NA> "
            "speaker_1 <NA> <NA>\n"
            "SPEAKER speaker-functional-5m 1 0.8 1.2 <NA> <NA> "
            "speaker_2 <NA> <NA>\n"
        )
        return generated, five, resource, rttm

    def _timings(self):
        return {
            "initializationMs": 1,
            "pcmAndWindowingMs": 1,
            "diarizationMs": 1,
            "embeddingMs": 1,
            "reconciliationMs": 1,
            "stitchingMs": 1,
            "totalMs": 6,
        }


if __name__ == "__main__":
    unittest.main()
