import Foundation
import Testing

@testable import NativeSecurity

@Suite("Electron native security core")
struct NativeSecurityTests {
  @Test("provider keys preserve the frozen Keychain identity and available secret")
  func availableSecret() throws {
    let backend = FakeKeychainBackend(readResult: .value(Data("  secret-value  ".utf8)))
    let store = ProviderSecretStore(backend: backend)

    #expect(try store.read(providerId: "deepseek") == .available("  secret-value  "))
    #expect(backend.lastService == "com.voice2text.desktop.meeting-ai")
    #expect(backend.lastAccount == "provider.deepseek.api-key")
  }

  @Test("missing denied and corrupt Keychain reads remain distinct")
  func unavailableStates() throws {
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(readResult: .missing)).read(
        providerId: "deepseek") == .missing)
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(readResult: .denied)).read(
        providerId: "deepseek") == .denied)
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(readResult: .value(Data([0xff])))).read(
        providerId: "deepseek") == .corrupt)
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(readResult: .value(Data()))).read(
        providerId: "deepseek") == .corrupt)
  }

  @Test("replace trims and stores a device-only non-synchronizable secret")
  func replaceSecret() throws {
    let backend = FakeKeychainBackend(readResult: .missing)
    let store = ProviderSecretStore(backend: backend)

    #expect(try store.replace(providerId: "custom.openai", secret: "  token  ") == .stored)
    #expect(backend.lastValue == Data("token".utf8))
    #expect(backend.lastAccessibility == .whenUnlockedThisDeviceOnly)
    #expect(backend.lastSynchronizable == false)
    #expect(backend.lastUsesDataProtectionKeychain == true)
  }

  @Test("invalid identifiers and secret lengths fail without calling Keychain")
  func invalidArguments() throws {
    let backend = FakeKeychainBackend(readResult: .missing)
    let store = ProviderSecretStore(backend: backend)

    #expect(throws: NativeSecurityFailure.self) {
      _ = try store.read(providerId: "INVALID")
    }
    #expect(throws: NativeSecurityFailure.self) {
      _ = try store.replace(providerId: "deepseek", secret: "   ")
    }
    #expect(backend.callCount == 0)
  }

  @Test("delete preserves deleted missing and denied states")
  func deleteSecret() throws {
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(deleteResult: .deleted)).delete(
        providerId: "deepseek") == .deleted)
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(deleteResult: .missing)).delete(
        providerId: "deepseek") == .missing)
    #expect(
      try ProviderSecretStore(backend: FakeKeychainBackend(deleteResult: .denied)).delete(
        providerId: "deepseek") == .denied)
  }

  @Test("FileVault reports only device security truth")
  func fileVaultTruth() {
    let enabled = FileVaultStatusProbe(runner: { _ in
      ProcessReceipt(exitCode: 0, stdout: "FileVault is On.", stderr: "")
    }).status()
    #expect(enabled == FileVaultStatusReceipt(state: .enabled))
    #expect(enabled.kind == "device-security")
    #expect(enabled.applicationLayerEncryption == "not-claimed")

    let disabled = FileVaultStatusProbe(runner: { _ in
      ProcessReceipt(exitCode: 1, stdout: "", stderr: "FileVault is Off.")
    }).status()
    #expect(disabled.state == .disabled)

    let unknown = FileVaultStatusProbe(runner: { _ in throw CocoaError(.fileReadNoPermission) })
      .status()
    #expect(unknown.state == .unknown)
  }

  @Test("FileVault command output is capped without pipe backpressure")
  func noisyFileVaultCommand() throws {
    let receipt = try BoundedProcessRunner(
      executableURL: URL(filePath: "/bin/sh"),
      deadlineSeconds: 2,
      outputLimit: 128
    ).run(arguments: [
      "-c",
      "i=0; while [ $i -lt 5000 ]; do printf x; printf y >&2; i=$((i+1)); done",
    ])

    #expect(receipt.exitCode == 0)
    #expect(receipt.stdout.utf8.count == 128)
    #expect(receipt.stderr.utf8.count == 128)
  }

  @Test("FileVault command timeout terminates a hung executable")
  func hungFileVaultCommand() {
    let startedAt = ContinuousClock.now
    #expect(throws: Error.self) {
      _ = try BoundedProcessRunner(
        executableURL: URL(filePath: "/bin/sleep"),
        deadlineSeconds: 0.1
      ).run(arguments: ["10"])
    }
    #expect(startedAt.duration(to: .now) < .seconds(2))
  }
}

private final class FakeKeychainBackend: KeychainBackend, @unchecked Sendable {
  var readResult: KeychainReadResult
  var replaceResult: KeychainReplaceResult
  var deleteResult: KeychainDeleteResult
  var callCount = 0
  var lastService: String?
  var lastAccount: String?
  var lastValue: Data?
  var lastAccessibility: KeychainAccessibility?
  var lastSynchronizable: Bool?
  var lastUsesDataProtectionKeychain: Bool?

  init(
    readResult: KeychainReadResult = .missing,
    replaceResult: KeychainReplaceResult = .stored,
    deleteResult: KeychainDeleteResult = .deleted
  ) {
    self.readResult = readResult
    self.replaceResult = replaceResult
    self.deleteResult = deleteResult
  }

  func read(service: String, account: String) -> KeychainReadResult {
    record(service: service, account: account)
    return readResult
  }

  func replace(
    service: String,
    account: String,
    value: Data,
    accessibility: KeychainAccessibility,
    synchronizable: Bool,
    usesDataProtectionKeychain: Bool
  ) -> KeychainReplaceResult {
    record(service: service, account: account)
    lastValue = value
    lastAccessibility = accessibility
    lastSynchronizable = synchronizable
    lastUsesDataProtectionKeychain = usesDataProtectionKeychain
    return replaceResult
  }

  func delete(service: String, account: String) -> KeychainDeleteResult {
    record(service: service, account: account)
    return deleteResult
  }

  private func record(service: String, account: String) {
    callCount += 1
    lastService = service
    lastAccount = account
  }
}
