import json
import tempfile
import unittest
from pathlib import Path

from validate_cancellation_probe import validate


class CancellationProbeTest(unittest.TestCase):
    def test_requires_worker_termination_cleanup_and_no_partial_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence.json"
            payload = {
                "schemaVersion": 1,
                "source": "macos_native_sherpa_worker",
                "complete": False,
                "timedOut": True,
                "cancelled": True,
                "temporaryArtifactsReleased": True,
                "nativeProgressCallbackCancellationSupported": False,
                "nativeCallbackReturnValueDisposition": "ignored_by_sherpa_1_13_4",
                "workerTermination": {
                    "boundary": "separate_process_group",
                    "nativeCheckpoint": "native_diarizer_initialized",
                    "terminationRequested": True,
                    "signal": "SIGTERM",
                    "processGroupGone": True,
                    "partialOutputPublished": False,
                    "exitCode": -15,
                },
                "publishedOutputFiles": [],
                "targetFingerprint": {
                    "operatingSystem": "macos",
                    "operatingSystemVersion": "15.7.5",
                    "architecture": "arm64",
                    "cpuModel": "Apple M2",
                    "logicalCpuCount": 8,
                    "memoryBytes": 17179869184,
                    "runtimeId": "sherpa-onnx-c-api",
                    "runtimeVersion": "1.13.4",
                    "runtimeSha256": "1" * 64,
                },
            }
            path.write_text(json.dumps(payload))
            validate(path)
            for field in ("timedOut", "cancelled", "temporaryArtifactsReleased"):
                broken = dict(payload)
                broken[field] = False
                path.write_text(json.dumps(broken))
                with self.assertRaises(ValueError):
                    validate(path)

            broken = dict(payload)
            broken["publishedOutputFiles"] = ["diarization-functional.json"]
            path.write_text(json.dumps(broken))
            with self.assertRaises(ValueError):
                validate(path)

            broken = dict(payload)
            broken["workerTermination"] = {
                **payload["workerTermination"],
                "partialOutputPublished": True,
            }
            path.write_text(json.dumps(broken))
            with self.assertRaises(ValueError):
                validate(path)
