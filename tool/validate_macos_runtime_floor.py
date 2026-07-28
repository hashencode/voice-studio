#!/usr/bin/env python3

from __future__ import annotations

import argparse
import plistlib
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = (
    ROOT
    / "apps/desktop/build/macos/Build/Products/Debug/voice2text_desktop.app"
)


def parse_minos(output: str) -> str:
    match = re.search(r"^\s*minos\s+(\d+\.\d+)", output, re.MULTILINE)
    if match is None:
        raise ValueError("Mach-O build version has no macOS minimum")
    return match.group(1)


def parse_dependencies(output: str) -> tuple[str, ...]:
    return tuple(
        line.strip().split(" (", 1)[0]
        for line in output.splitlines()[1:]
        if line.startswith("\t")
    )


def _run(*arguments: str) -> str:
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _minos(path: Path) -> str:
    return parse_minos(_run("xcrun", "vtool", "-show-build", str(path)))


def validate(app: Path = DEFAULT_APP) -> dict[str, object]:
    if not app.is_dir():
        raise ValueError(f"macOS app is missing: {app}")
    contents = app / "Contents"
    launch_components = {
        "executable": contents / "MacOS/voice2text_desktop",
        "debugDylib": contents / "MacOS/voice2text_desktop.debug.dylib",
        "appFramework": contents / "Frameworks/App.framework/Versions/A/App",
        "processGroupLauncher": (
            contents / "Resources/Processing/native_process_group_launcher"
        ),
    }
    for label, path in launch_components.items():
        if _minos(path) != "13.0":
            raise ValueError(f"{label} no longer targets macOS 13.0")

    main_dependencies = parse_dependencies(
        _run("otool", "-L", str(launch_components["debugDylib"]))
    )
    if any(
        token in dependency.lower()
        for dependency in main_dependencies
        for token in ("onnx", "sherpa")
    ):
        raise ValueError("main app launch graph links Sherpa/ONNX")

    worker = contents / "Resources/Processing/desktop_sherpa_worker"
    onnx = contents / "Frameworks/libonnxruntime.1.27.0.dylib"
    if _minos(worker) != "14.0":
        raise ValueError("isolated Dart worker minimum changed")
    if _minos(onnx) != "15.5":
        raise ValueError("frozen ONNX Runtime minimum changed")

    with (contents / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("LSMinimumSystemVersion") != "13.0":
        raise ValueError("Info.plist no longer advertises macOS 13.0")

    subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", str(app)],
        check=True,
        capture_output=True,
        text=True,
    )
    return {
        "applicationMinimumMacosVersion": "13.0",
        "microphoneOnlyCaptureMinimumMacosVersion": "13.0",
        "systemAudioCaptureMinimumMacosVersion": "14.2",
        "localProcessingMinimumMacosVersion": "15.5",
        "mainLaunchDependencyCount": len(main_dependencies),
        "mainLinksSherpaOrOnnx": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, default=DEFAULT_APP)
    args = parser.parse_args()
    result = validate(args.app)
    print(
        "macOS runtime floor contract passed: "
        f"app={result['applicationMinimumMacosVersion']}, "
        f"microphone-only={result['microphoneOnlyCaptureMinimumMacosVersion']}, "
        f"dual-track={result['systemAudioCaptureMinimumMacosVersion']}, "
        f"local-processing={result['localProcessingMinimumMacosVersion']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
