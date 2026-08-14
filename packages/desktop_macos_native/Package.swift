// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "desktop_macos_native",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "SecureImport", targets: ["SecureImport"]),
    .library(name: "CaptureCore", targets: ["CaptureCore"]),
    .library(name: "NativeSecurity", targets: ["NativeSecurity"]),
    .executable(
      name: "desktop_macos_native_helper",
      targets: ["DesktopMacOSNativeHelper"]
    ),
  ],
  targets: [
    .target(name: "SecureImport"),
    .target(name: "CaptureCore"),
    .target(
      name: "NativeSecurity",
      linkerSettings: [
        .linkedFramework("LocalAuthentication"),
        .linkedFramework("Security"),
      ]
    ),
    .executableTarget(
      name: "DesktopMacOSNativeHelper",
      dependencies: ["SecureImport", "CaptureCore", "NativeSecurity"]
    ),
    .testTarget(name: "SecureImportTests", dependencies: ["SecureImport"]),
    .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    .testTarget(name: "NativeSecurityTests", dependencies: ["NativeSecurity"]),
  ]
)
