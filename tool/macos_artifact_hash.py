#!/usr/bin/env python3
"""Stable SHA-256 for Dart AOT Mach-O executables.

`dart compile exe` embeds a random compiler workspace path and a 32-byte
snapshot build identifier. macOS code signatures also cover those bytes. This
module masks only those non-semantic fields before hashing; executable code and
all other Mach-O content remain evidence-bearing.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import struct
from pathlib import Path

MACHO_64_LITTLE_ENDIAN = 0xFEEDFACF
LC_CODE_SIGNATURE = 0x1D
LC_NOTE = 0x31
DART_SNAPSHOT_OWNER = b"__dart_app_snap"
COMPILER_PATH_PATTERN = re.compile(
    rb"(/T/)[A-Za-z0-9]{6}(/snapshot\.aot)"
)


def semantic_dart_macho_sha256(path: Path) -> str:
    data = bytearray(path.read_bytes())
    if len(data) < 32 or struct.unpack_from("<I", data, 0)[0] != MACHO_64_LITTLE_ENDIAN:
        raise ValueError(f"not a little-endian 64-bit Mach-O: {path}")

    data[:] = COMPILER_PATH_PATTERN.sub(rb"\1stable\2", bytes(data))
    command_count = struct.unpack_from("<I", data, 16)[0]
    command_offset = 32
    dart_snapshot_found = False
    signature_found = False

    for _ in range(command_count):
        if command_offset + 8 > len(data):
            raise ValueError(f"truncated Mach-O load command: {path}")
        command, command_size = struct.unpack_from("<II", data, command_offset)
        if command_size < 8 or command_offset + command_size > len(data):
            raise ValueError(f"invalid Mach-O load command: {path}")

        if command == LC_NOTE:
            if command_size < 40:
                raise ValueError(f"invalid LC_NOTE command: {path}")
            owner = bytes(data[command_offset + 8 : command_offset + 24]).rstrip(b"\0")
            note_offset, note_size = struct.unpack_from(
                "<QQ", data, command_offset + 24
            )
            if owner == DART_SNAPSHOT_OWNER:
                if note_size < 32 or note_offset + note_size > len(data):
                    raise ValueError(f"invalid Dart snapshot note: {path}")
                data[note_offset + note_size - 32 : note_offset + note_size] = b"\0" * 32
                dart_snapshot_found = True
        elif command == LC_CODE_SIGNATURE:
            if command_size < 16:
                raise ValueError(f"invalid LC_CODE_SIGNATURE command: {path}")
            signature_offset, signature_size = struct.unpack_from(
                "<II", data, command_offset + 8
            )
            if signature_offset + signature_size > len(data):
                raise ValueError(f"invalid Mach-O code signature: {path}")
            data[signature_offset : signature_offset + signature_size] = (
                b"\0" * signature_size
            )
            signature_found = True

        command_offset += command_size

    if not dart_snapshot_found:
        raise ValueError(f"Dart application snapshot note not found: {path}")
    if not signature_found:
        raise ValueError(f"Mach-O code signature not found: {path}")
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(semantic_dart_macho_sha256(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

