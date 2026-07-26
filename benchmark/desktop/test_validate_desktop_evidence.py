import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from validate_desktop_evidence import EvidenceError, validate


class DesktopEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.contract = {
            "contractId": "test",
            "decisionPlatform": "macos",
            "source": "macos_native_sherpa",
            "runtime": {"id": "s", "version": "1", "sha256": "a" * 64},
            "benchmarkConfiguration": {
                "numThreads": 2,
                "peakRssSampling": "every_native_progress_callback",
            },
            "models": {
                "asr": [{"id": "m", "sha256": "e" * 64}],
                "diarization": [{"id": "m", "sha256": "e" * 64}],
            },
            "gates": {
                "asr": {
                    "fixtureId": "asr", "fixtureSha256": "b" * 64,
                    "maxCer": 0.5, "maxRtf": 0.5,
                },
                "diarization": {
                    "functionalFixtureId": "five",
                    "functionalFixtureSha256": "c" * 64,
                    "resourceFixtureId": "two-hour",
                    "resourceFixtureSha256": "d" * 64,
                    "maxRtf": 0.5,
                    "maxIncrementalPeakRssBytes": 1000,
                },
            },
        }
        self.contract_path = self.root / "contract.json"
        self.contract_path.write_text(json.dumps(self.contract))
        common = {
            "schemaVersion": 1, "contractId": "test",
            "source": "macos_native_sherpa", "complete": True,
            "timedOut": False, "cancelled": False,
            "temporaryArtifactsReleased": True,
            "configuration": {"numThreads": 2},
            "targetFingerprint": {
                "operatingSystem": "macos", "operatingSystemVersion": "15",
                "architecture": "arm64", "cpuModel": "Apple",
                "logicalCpuCount": 8, "memoryBytes": 8 * 1024**3,
                "runtimeId": "s", "runtimeVersion": "1",
                "runtimeSha256": "a" * 64,
            },
            "models": [{
                "id": "m", "version": "1", "sha256": "e" * 64,
                "licenseDisposition": "BENCHMARK_ONLY",
            }],
        }
        self.evidence = {
            "asr": {
                **copy.deepcopy(common), "probe": "asr",
                "fixture": {"id": "asr", "sha256": "b" * 64, "durationSeconds": 2},
                "segments": [{"startSeconds": 0, "endSeconds": 1, "text": "ok"}],
                "metrics": {"cer": 0.1, "rtf": 0.1},
            },
            "diarization-functional": {
                **copy.deepcopy(common), "probe": "diarization-functional",
                "fixture": {"id": "five", "sha256": "c" * 64, "durationSeconds": 300},
                "segments": [
                    {"startSeconds": 0, "endSeconds": 1, "speakerKey": "speaker_01"},
                    {"startSeconds": 0.5, "endSeconds": 1.5, "speakerKey": "speaker_02"},
                ],
                "silenceSuppression": {"speakerOverlapSecondsAfterSuppression": 0},
                "metrics": {"rtf": 0.1},
            },
            "diarization-resource": {
                **copy.deepcopy(common), "probe": "diarization-resource",
                "fixture": {"id": "two-hour", "sha256": "d" * 64, "durationSeconds": 7200},
                "completedFullDuration": True, "oom": False,
                "configuration": {
                    "numThreads": 2,
                    "peakRssSampling": "every_native_progress_callback",
                },
                "metrics": {"rtf": 0.1, "incrementalPeakRssBytes": 100},
            },
        }
        self._write()

    def tearDown(self):
        self.temporary.cleanup()

    def _write(self):
        hashes = {}
        for name, payload in self.evidence.items():
            path = self.root / f"{name}.json"
            path.write_text(json.dumps(payload))
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        (self.root / "index.json").write_text(json.dumps({
            "contractId": "test", "evidenceSha256": hashes,
        }))

    def test_accepts_complete_target_bound_evidence(self):
        self.assertEqual(set(validate(self.root, self.contract_path)), set(self.evidence))

    def test_rejects_missing_target_field(self):
        del self.evidence["asr"]["targetFingerprint"]["cpuModel"]
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_other_target_model(self):
        self.evidence["asr"]["models"][0]["sha256"] = "f" * 64
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_other_runtime_hash(self):
        self.evidence["asr"]["targetFingerprint"]["runtimeSha256"] = "f" * 64
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_other_fixture_hash(self):
        self.evidence["asr"]["fixture"]["sha256"] = "f" * 64
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_android_evidence_for_mac_decision(self):
        self.evidence["asr"]["targetFingerprint"]["operatingSystem"] = "android"
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_out_of_bounds_timestamp(self):
        self.evidence["asr"]["segments"][0]["endSeconds"] = 3
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_incomplete_two_hour_probe(self):
        self.evidence["diarization-resource"]["completedFullDuration"] = False
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_speaker_output_in_detected_silence(self):
        self.evidence["diarization-functional"]["silenceSuppression"][
            "speakerOverlapSecondsAfterSuppression"
        ] = 0.25
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_fake_single_speaker_output(self):
        self.evidence["diarization-functional"]["segments"] = [
            {"startSeconds": 0, "endSeconds": 1, "speakerKey": "speaker_01"},
        ]
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)

    def test_rejects_voiceprint_or_raw_payload(self):
        self.evidence["diarization-functional"]["voiceprints"] = ["secret"]
        self._write()
        with self.assertRaises(EvidenceError):
            validate(self.root, self.contract_path)


if __name__ == "__main__":
    unittest.main()
