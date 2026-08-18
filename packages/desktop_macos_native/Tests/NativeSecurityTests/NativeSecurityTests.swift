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
    #expect(backend.lastService == "com.voice2text.desktop.audio-ai")
    #expect(backend.lastAccount == "provider.deepseek.api-key")
  }

  @Test("a missing Audio service migrates the released provider secret once")
  func migratesLegacyProviderSecret() throws {
    let account = "provider.deepseek.api-key"
    let backend = MigratingKeychainBackend(values: [
      "com.voice2text.desktop.meeting-ai|\(account)": Data("legacy-secret".utf8)
    ])
    let store = ProviderSecretStore(backend: backend)

    #expect(try store.read(providerId: "deepseek") == .available("legacy-secret"))
    #expect(backend.values["com.voice2text.desktop.audio-ai|\(account)"] == Data("legacy-secret".utf8))
    #expect(backend.values["com.voice2text.desktop.meeting-ai|\(account)"] == nil)
    #expect(backend.operations == [
      "read:com.voice2text.desktop.audio-ai|\(account)",
      "read:com.voice2text.desktop.meeting-ai|\(account)",
      "replace:com.voice2text.desktop.audio-ai|\(account)",
      "delete:com.voice2text.desktop.meeting-ai|\(account)",
    ])
  }

  @Test("a failed Audio service migration retains the released provider secret")
  func preservesLegacyProviderSecretWhenMigrationWriteFails() {
    let account = "provider.deepseek.api-key"
    let legacyKey = "com.voice2text.desktop.meeting-ai|\(account)"
    let audioKey = "com.voice2text.desktop.audio-ai|\(account)"
    let backend = MigratingKeychainBackend(
      values: [legacyKey: Data("legacy-secret".utf8)],
      replaceResult: .denied
    )
    let store = ProviderSecretStore(backend: backend)

    #expect(throws: NativeSecurityFailure.self) {
      _ = try store.read(providerId: "deepseek")
    }
    #expect(backend.values[legacyKey] == Data("legacy-secret".utf8))
    #expect(backend.values[audioKey] == nil)
    #expect(backend.operations == [
      "read:com.voice2text.desktop.audio-ai|\(account)",
      "read:com.voice2text.desktop.meeting-ai|\(account)",
      "replace:com.voice2text.desktop.audio-ai|\(account)",
    ])
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

  @Test("companion credentials preserve frozen service accounts and encoding")
  func companionCredentialIdentity() throws {
    let backend = FakeKeychainBackend(readResult: .missing)
    let store = CompanionCredentialStore(backend: backend)
    let credential = Data((0..<32).map(UInt8.init))

    #expect(
      try store.replace(.identitySeed, credential: credential) == .stored)
    #expect(backend.lastService == "com.voice2text.desktop.companion")
    #expect(backend.lastAccount == "companion.identity.seed.v1")
    #expect(backend.lastValue == Data(credential.base64EncodedString().utf8))
    #expect(backend.lastAccessibility == .whenUnlockedThisDeviceOnly)
    #expect(backend.lastSynchronizable == false)
    #expect(backend.lastUsesDataProtectionKeychain == true)

    backend.readResult = .value(Data(credential.base64EncodedString().utf8))
    #expect(try store.read(.peer(deviceId: "android-01")) == .available(credential))
    #expect(backend.lastAccount == "companion.peer.android-01.credential.v1")
    #expect(try store.delete(.peer(deviceId: "android-01")) == .deleted)
    #expect(backend.lastService == "com.voice2text.desktop.companion")
    #expect(backend.lastAccount == "companion.peer.android-01.credential.v1")
  }

  @Test("companion credentials reject invalid identities sizes and corrupt values")
  func companionCredentialBounds() throws {
    let backend = FakeKeychainBackend(readResult: .value(Data("not-base64".utf8)))
    let store = CompanionCredentialStore(backend: backend)

    #expect(try store.read(.identitySeed) == .corrupt)
    #expect(throws: NativeSecurityFailure.self) {
      _ = try store.read(.peer(deviceId: "invalid peer"))
    }
    #expect(throws: NativeSecurityFailure.self) {
      _ = try store.replace(.identitySeed, credential: Data(repeating: 1, count: 31))
    }
  }

  @Test("companion discovery requires opt-in and advertises only the receiver protocol")
  func companionDiscoveryRegistration() throws {
    let backend = FakeCompanionBonjourBackend(result: .registered(name: "Voice2Text Mac"))
    let discovery = CompanionDiscoveryRegistrar(backend: backend)

    #expect(throws: NativeSecurityFailure.self) {
      _ = try discovery.register(
        CompanionDiscoveryRequest(
          userInitiated: false,
          port: 4242,
          deviceId: "desktop-01",
          deviceName: "Voice2Text Mac",
          fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        ))
    }
    #expect(throws: NativeSecurityFailure.self) {
      _ = try discovery.register(
        CompanionDiscoveryRequest(
          userInitiated: true,
          port: 4242,
          deviceId: "desktop-01",
          deviceName: String(repeating: "x", count: 64),
          fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        ))
    }
    let receipt = try discovery.register(
      CompanionDiscoveryRequest(
        userInitiated: true,
        port: 4242,
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      ))

    #expect(receipt.state == .registered)
    #expect(receipt.manualFallbackAvailable == false)
    #expect(backend.lastAdvertisement?.domain == "local.")
    #expect(backend.lastAdvertisement?.serviceType == "_voice2text-audio._tcp.")
    #expect(backend.lastAdvertisement?.port == 4242)
    #expect(
      backend.lastAdvertisement?.txtRecord == [
        "schema": "companion-audio-transfer/v2",
        "capability": "audio-transfer/v2",
        "deviceId": "desktop-01",
        "fingerprint": "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      ])
    #expect(backend.listenerCreated == false)
  }

  @Test("companion discovery permission failures preserve manual fallback")
  func companionDiscoveryFallback() throws {
    for (result, expectedState) in [
      (
        CompanionBonjourRegistrationResult.permissionDenied,
        CompanionDiscoveryState.permissionDenied
      ),
      (.permissionPending, .permissionPending),
      (.unavailable, .unavailable),
    ] {
      let backend = FakeCompanionBonjourBackend(result: result)
      let discovery = CompanionDiscoveryRegistrar(backend: backend)
      let receipt = try discovery.register(
        CompanionDiscoveryRequest(
          userInitiated: true,
          port: 4242,
          deviceId: "desktop-01",
          deviceName: "Voice2Text Mac",
          fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        ))
      #expect(receipt.state == expectedState)
      #expect(receipt.manualFallbackAvailable == true)
    }
  }

  @Test("pending discovery converges to its late registered name without republishing")
  func companionDiscoveryLateSuccess() throws {
    let backend = FakeCompanionBonjourBackend(result: .permissionPending)
    let discovery = CompanionDiscoveryRegistrar(backend: backend)
    let request = CompanionDiscoveryRequest(
      userInitiated: true,
      port: 4242,
      deviceId: "desktop-01",
      deviceName: "Voice2Text Mac",
      fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    )

    #expect(try discovery.register(request).state == .permissionPending)
    backend.statusResult = .registered(name: "Voice2Text Mac (2)")
    #expect(discovery.status().registeredName == "Voice2Text Mac (2)")
    #expect(try discovery.register(request).registeredName == "Voice2Text Mac (2)")
    #expect(backend.registerCallCount == 1)
    #expect(discovery.unregister().state == .stopped)
    #expect(discovery.unregister().state == .stopped)
    #expect(backend.stopCallCount == 1)
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

private final class MigratingKeychainBackend: KeychainBackend {
  var values: [String: Data]
  var operations: [String] = []
  var replaceResult: KeychainReplaceResult
  var deleteResult: KeychainDeleteResult

  init(
    values: [String: Data],
    replaceResult: KeychainReplaceResult = .stored,
    deleteResult: KeychainDeleteResult = .deleted
  ) {
    self.values = values
    self.replaceResult = replaceResult
    self.deleteResult = deleteResult
  }

  func read(service: String, account: String) -> KeychainReadResult {
    let key = "\(service)|\(account)"
    operations.append("read:\(key)")
    return values[key].map(KeychainReadResult.value) ?? .missing
  }

  func replace(
    service: String,
    account: String,
    value: Data,
    accessibility: KeychainAccessibility,
    synchronizable: Bool,
    usesDataProtectionKeychain: Bool
  ) -> KeychainReplaceResult {
    let key = "\(service)|\(account)"
    operations.append("replace:\(key)")
    if case .stored = replaceResult {
      values[key] = value
    }
    return replaceResult
  }

  func delete(service: String, account: String) -> KeychainDeleteResult {
    let key = "\(service)|\(account)"
    operations.append("delete:\(key)")
    if case .deleted = deleteResult {
      values.removeValue(forKey: key)
    }
    return deleteResult
  }
}

private final class FakeCompanionBonjourBackend: CompanionBonjourBackend, @unchecked Sendable {
  var result: CompanionBonjourRegistrationResult
  var statusResult: CompanionBonjourRegistrationResult?
  var lastAdvertisement: CompanionBonjourAdvertisement?
  var listenerCreated = false
  var registerCallCount = 0
  var stopCallCount = 0

  init(result: CompanionBonjourRegistrationResult) {
    self.result = result
  }

  func register(
    _ advertisement: CompanionBonjourAdvertisement
  ) -> CompanionBonjourRegistrationResult {
    registerCallCount += 1
    lastAdvertisement = advertisement
    return result
  }

  func status() -> CompanionBonjourRegistrationResult? { statusResult }

  func stop() { stopCallCount += 1 }
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
