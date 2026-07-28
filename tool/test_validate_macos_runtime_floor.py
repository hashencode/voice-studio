from __future__ import annotations

import unittest

from tool.validate_macos_runtime_floor import (
    parse_dependencies,
    parse_minos,
)


class MacosRuntimeFloorTest(unittest.TestCase):
    def test_parses_macos_build_minimum(self) -> None:
        self.assertEqual(
            "13.0",
            parse_minos(
                """
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 13.0
      sdk 15.2
"""
            ),
        )

    def test_parses_linked_dependencies(self) -> None:
        self.assertEqual(
            (
                "@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS",
                "/usr/lib/libSystem.B.dylib",
            ),
            parse_dependencies(
                """binary:
\t@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS (compatibility version 0.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)
"""
            ),
        )


if __name__ == "__main__":
    unittest.main()
