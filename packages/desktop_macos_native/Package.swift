// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "desktop_macos_native",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "SecureImport", targets: ["SecureImport"]),
    .executable(
      name: "desktop_macos_native_helper",
      targets: ["DesktopMacOSNativeHelper"]
    ),
  ],
  targets: [
    .target(name: "SecureImport"),
    .executableTarget(
      name: "DesktopMacOSNativeHelper",
      dependencies: ["SecureImport"]
    ),
    .testTarget(name: "SecureImportTests", dependencies: ["SecureImport"]),
  ]
)
