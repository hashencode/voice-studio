from __future__ import annotations

import hashlib
import struct
import tempfile
import unittest
from pathlib import Path

from tool.macos_artifact_hash import semantic_dart_macho_sha256


def _fixture(
    *,
    compiler_token: bytes,
    snapshot_identifier: bytes,
    signature: bytes,
    code_byte: int = 0x42,
) -> bytes:
    note_offset = 160
    note_size = 96
    signature_offset = 256
    signature_size = 48
    header = struct.pack(
        "<IIIIIIII",
        0xFEEDFACF,
        0,
        0,
        0,
        2,
        56,
        0,
        0,
    )
    note = struct.pack(
        "<II16sQQ",
        0x31,
        40,
        b"__dart_app_snap",
        note_offset,
        note_size,
    )
    code_signature = struct.pack(
        "<IIII",
        0x1D,
        16,
        signature_offset,
        signature_size,
    )
    data = bytearray(304)
    data[:32] = header
    data[32:72] = note
    data[72:88] = code_signature
    data[96] = code_byte
    compiler_path = b"/T/" + compiler_token + b"/snapshot.aot"
    data[note_offset : note_offset + len(compiler_path)] = compiler_path
    data[note_offset + note_size - 32 : note_offset + note_size] = snapshot_identifier
    data[signature_offset : signature_offset + signature_size] = signature
    return bytes(data)


class MacosArtifactHashTest(unittest.TestCase):
    def _hash(self, content: bytes) -> str:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "worker"
            path.write_bytes(content)
            return semantic_dart_macho_sha256(path)

    def test_non_semantic_dart_and_signature_fields_are_masked(self) -> None:
        first = _fixture(
            compiler_token=b"Ab12Cd",
            snapshot_identifier=b"a" * 32,
            signature=b"b" * 48,
        )
        second = _fixture(
            compiler_token=b"Z9y8X7",
            snapshot_identifier=b"c" * 32,
            signature=b"d" * 48,
        )
        self.assertEqual(self._hash(first), self._hash(second))

    def test_executable_content_remains_evidence_bearing(self) -> None:
        first = _fixture(
            compiler_token=b"Ab12Cd",
            snapshot_identifier=b"a" * 32,
            signature=b"b" * 48,
        )
        changed = _fixture(
            compiler_token=b"Ab12Cd",
            snapshot_identifier=b"a" * 32,
            signature=b"b" * 48,
            code_byte=0x43,
        )
        self.assertNotEqual(self._hash(first), self._hash(changed))

    def test_digest_is_sha256(self) -> None:
        content = _fixture(
            compiler_token=b"Ab12Cd",
            snapshot_identifier=b"a" * 32,
            signature=b"b" * 48,
        )
        digest = self._hash(content)
        self.assertEqual(64, len(digest))
        int(digest, 16)
        self.assertNotEqual(hashlib.sha256(content).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()

