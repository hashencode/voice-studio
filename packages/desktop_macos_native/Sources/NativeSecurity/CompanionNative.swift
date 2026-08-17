import Dispatch
import Foundation
import dnssd

public enum CompanionCredentialKey: Equatable, Sendable {
  case identitySeed
  case peer(deviceId: String)
}

public enum CompanionCredentialRead: Equatable, Sendable {
  case available(Data)
  case missing
  case denied
  case corrupt
}

public final class CompanionCredentialStore: @unchecked Sendable {
  public static let service = "com.voice2text.desktop.companion"
  private static let credentialBytes = 32
  private let backend: KeychainBackend

  public init(backend: KeychainBackend = SystemKeychainBackend()) {
    self.backend = backend
  }

  public func read(_ key: CompanionCredentialKey) throws -> CompanionCredentialRead {
    switch backend.read(service: Self.service, account: try account(key)) {
    case .value(let encoded):
      guard
        let text = String(data: encoded, encoding: .utf8),
        let credential = Data(base64Encoded: text),
        credential.count == Self.credentialBytes,
        credential.base64EncodedString() == text
      else { return .corrupt }
      return .available(credential)
    case .missing:
      return .missing
    case .denied:
      return .denied
    case .unavailable:
      throw NativeSecurityFailure(
        "KEYCHAIN_UNAVAILABLE",
        "Keychain is unavailable"
      )
    case .failure:
      throw NativeSecurityFailure(
        "KEYCHAIN_OPERATION_FAILED",
        "Keychain read failed"
      )
    }
  }

  public func replace(
    _ key: CompanionCredentialKey,
    credential: Data
  ) throws -> ProviderSecretMutationState {
    guard credential.count == Self.credentialBytes else {
      throw NativeSecurityFailure(
        "KEYCHAIN_ARGUMENTS_INVALID",
        "companion credential must contain exactly 32 bytes"
      )
    }
    let encoded = Data(credential.base64EncodedString().utf8)
    switch backend.replace(
      service: Self.service,
      account: try account(key),
      value: encoded,
      accessibility: .whenUnlockedThisDeviceOnly,
      synchronizable: false,
      usesDataProtectionKeychain: true
    ) {
    case .stored:
      return .stored
    case .denied:
      throw NativeSecurityFailure(
        "KEYCHAIN_ACCESS_DENIED",
        "Keychain access was denied"
      )
    case .unavailable:
      throw NativeSecurityFailure(
        "KEYCHAIN_UNAVAILABLE",
        "Keychain is unavailable"
      )
    case .failure:
      throw NativeSecurityFailure(
        "KEYCHAIN_OPERATION_FAILED",
        "Keychain write failed"
      )
    }
  }

  public func delete(
    _ key: CompanionCredentialKey
  ) throws -> ProviderSecretMutationState {
    switch backend.delete(service: Self.service, account: try account(key)) {
    case .deleted:
      return .deleted
    case .missing:
      return .missing
    case .denied:
      return .denied
    case .unavailable:
      throw NativeSecurityFailure(
        "KEYCHAIN_UNAVAILABLE",
        "Keychain is unavailable"
      )
    case .failure:
      throw NativeSecurityFailure(
        "KEYCHAIN_OPERATION_FAILED",
        "Keychain delete failed"
      )
    }
  }

  private func account(_ key: CompanionCredentialKey) throws -> String {
    switch key {
    case .identitySeed:
      return "companion.identity.seed.v1"
    case .peer(let deviceId):
      guard
        deviceId.range(
          of: #"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$"#,
          options: .regularExpression
        ) != nil
      else {
        throw NativeSecurityFailure(
          "KEYCHAIN_ARGUMENTS_INVALID",
          "companion peer identifier is invalid"
        )
      }
      return "companion.peer.\(deviceId).credential.v1"
    }
  }
}

public struct CompanionDiscoveryRequest: Equatable, Sendable {
  public let userInitiated: Bool
  public let port: Int
  public let deviceId: String
  public let deviceName: String
  public let fingerprint: String

  public init(
    userInitiated: Bool,
    port: Int,
    deviceId: String,
    deviceName: String,
    fingerprint: String
  ) {
    self.userInitiated = userInitiated
    self.port = port
    self.deviceId = deviceId
    self.deviceName = deviceName
    self.fingerprint = fingerprint
  }
}

public struct CompanionBonjourAdvertisement: Equatable, Sendable {
  public let domain: String
  public let serviceType: String
  public let name: String
  public let port: Int
  public let txtRecord: [String: String]
}

public enum CompanionBonjourRegistrationResult: Equatable, Sendable {
  case registered(name: String)
  case permissionDenied
  case permissionPending
  case unavailable
}

public protocol CompanionBonjourBackend: AnyObject {
  func register(
    _ advertisement: CompanionBonjourAdvertisement
  ) -> CompanionBonjourRegistrationResult
  func status() -> CompanionBonjourRegistrationResult?
  func stop()
}

public enum CompanionDiscoveryState: String, Codable, Equatable, Sendable {
  case registered
  case permissionDenied = "permission-denied"
  case permissionPending = "permission-pending"
  case unavailable
  case stopped
}

public struct CompanionDiscoveryReceipt: Encodable, Equatable, Sendable {
  public let schemaVersion = 1
  public let state: CompanionDiscoveryState
  public let serviceType = "_voice2text-audio._tcp."
  public let port: Int?
  public let registeredName: String?
  public let manualFallbackAvailable: Bool
}

public final class CompanionDiscoveryRegistrar: @unchecked Sendable {
  private let backend: CompanionBonjourBackend
  private var activeRequest: CompanionDiscoveryRequest?
  private var receipt = CompanionDiscoveryReceipt(
    state: .stopped,
    port: nil,
    registeredName: nil,
    manualFallbackAvailable: true
  )

  public init(backend: CompanionBonjourBackend = SystemCompanionBonjourBackend()) {
    self.backend = backend
  }

  public func register(
    _ request: CompanionDiscoveryRequest
  ) throws -> CompanionDiscoveryReceipt {
    try validate(request)
    if activeRequest == request,
      receipt.state == .registered || receipt.state == .permissionPending
    {
      return status()
    }
    let advertisement = CompanionBonjourAdvertisement(
      domain: "local.",
      serviceType: "_voice2text-audio._tcp.",
      name: request.deviceName,
      port: request.port,
      txtRecord: [
        "schema": "companion-audio-transfer/v2",
        "capability": "audio-transfer/v2",
        "deviceId": request.deviceId,
        "fingerprint": request.fingerprint,
      ]
    )
    activeRequest = request
    switch backend.register(advertisement) {
    case .registered(let name):
      receipt = CompanionDiscoveryReceipt(
        state: .registered,
        port: request.port,
        registeredName: name,
        manualFallbackAvailable: false
      )
    case .permissionDenied:
      receipt = fallbackReceipt(state: .permissionDenied, port: request.port)
      activeRequest = nil
    case .permissionPending:
      receipt = fallbackReceipt(state: .permissionPending, port: request.port)
    case .unavailable:
      receipt = fallbackReceipt(state: .unavailable, port: request.port)
      activeRequest = nil
    }
    return receipt
  }

  public func status() -> CompanionDiscoveryReceipt {
    guard receipt.state == .permissionPending || receipt.state == .registered,
      let activeRequest,
      let result = backend.status()
    else { return receipt }
    switch result {
    case .registered(let name):
      receipt = CompanionDiscoveryReceipt(
        state: .registered,
        port: activeRequest.port,
        registeredName: name,
        manualFallbackAvailable: false
      )
    case .permissionDenied:
      backend.stop()
      receipt = fallbackReceipt(state: .permissionDenied, port: activeRequest.port)
      self.activeRequest = nil
    case .permissionPending:
      break
    case .unavailable:
      backend.stop()
      receipt = fallbackReceipt(state: .unavailable, port: activeRequest.port)
      self.activeRequest = nil
    }
    return receipt
  }

  public func unregister() -> CompanionDiscoveryReceipt {
    if activeRequest != nil { backend.stop() }
    activeRequest = nil
    receipt = fallbackReceipt(state: .stopped, port: nil)
    return receipt
  }

  private func validate(_ request: CompanionDiscoveryRequest) throws {
    guard
      request.userInitiated,
      (1...65_535).contains(request.port),
      request.deviceId.range(
        of: #"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$"#,
        options: .regularExpression
      ) != nil,
      boundedText(request.deviceName, maximum: 63),
      request.fingerprint.range(
        of: #"^[A-Z2-7]{20,64}$"#,
        options: .regularExpression
      ) != nil
    else {
      throw NativeSecurityFailure(
        "COMPANION_DISCOVERY_ARGUMENTS_INVALID",
        "companion discovery requires explicit opt-in and valid receiver metadata"
      )
    }
  }

  private func boundedText(_ value: String, maximum: Int) -> Bool {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return !normalized.isEmpty
      && value.utf8.count <= maximum
      && value.unicodeScalars.allSatisfy { $0.value >= 0x20 }
  }

  private func fallbackReceipt(
    state: CompanionDiscoveryState,
    port: Int?
  ) -> CompanionDiscoveryReceipt {
    CompanionDiscoveryReceipt(
      state: state,
      port: port,
      registeredName: nil,
      manualFallbackAvailable: true
    )
  }
}

public final class SystemCompanionBonjourBackend: CompanionBonjourBackend, @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.voice2text.desktop.companion-discovery")
  private var service: DNSServiceRef?
  private var callback: CompanionBonjourCallback?

  public init() {}

  public func register(
    _ advertisement: CompanionBonjourAdvertisement
  ) -> CompanionBonjourRegistrationResult {
    stop()
    guard let txt = encodeTxtRecord(advertisement.txtRecord) else {
      return .unavailable
    }
    let callback = CompanionBonjourCallback()
    let initial = queue.sync { () -> DNSServiceErrorType in
      var reference: DNSServiceRef?
      let registration = txt.withUnsafeBytes { bytes in
        DNSServiceRegister(
          &reference,
          0,
          0,
          advertisement.name,
          advertisement.serviceType,
          advertisement.domain,
          nil,
          UInt16(advertisement.port).bigEndian,
          UInt16(txt.count),
          bytes.baseAddress,
          companionBonjourReply,
          Unmanaged.passUnretained(callback).toOpaque()
        )
      }
      guard registration == kDNSServiceErr_NoError else {
        if let reference { DNSServiceRefDeallocate(reference) }
        return registration
      }
      guard let reference else { return DNSServiceErrorType(kDNSServiceErr_Unknown) }
      self.service = reference
      self.callback = callback
      let scheduled = DNSServiceSetDispatchQueue(reference, queue)
      if scheduled != kDNSServiceErr_NoError {
        DNSServiceRefDeallocate(reference)
        self.service = nil
        self.callback = nil
      }
      return scheduled
    }
    guard initial == kDNSServiceErr_NoError else {
      return mapBonjourError(initial)
    }

    if callback.waitForResult(seconds: 2), let result = callback.result {
      if case .registered = result { return result }
      stop()
      return result
    }
    return .permissionPending
  }

  public func stop() {
    queue.sync {
      if let service { DNSServiceRefDeallocate(service) }
      service = nil
      callback = nil
    }
  }

  public func status() -> CompanionBonjourRegistrationResult? {
    queue.sync { callback?.result }
  }
}

private final class CompanionBonjourCallback: @unchecked Sendable {
  private let lock = NSLock()
  private let completed = DispatchSemaphore(value: 0)
  private var storedResult: CompanionBonjourRegistrationResult?

  var result: CompanionBonjourRegistrationResult? {
    lock.withLock { storedResult }
  }

  func complete(_ result: CompanionBonjourRegistrationResult) {
    lock.withLock { storedResult = result }
    completed.signal()
  }

  func waitForResult(seconds: Double) -> Bool {
    completed.wait(timeout: .now() + seconds) == .success
  }
}

private let companionBonjourReply: DNSServiceRegisterReply = {
  _, _, error, name, _, _, context in
  guard let context else { return }
  let callback = Unmanaged<CompanionBonjourCallback>
    .fromOpaque(context)
    .takeUnretainedValue()
  if error == kDNSServiceErr_NoError, let name {
    callback.complete(.registered(name: String(cString: name)))
  } else {
    callback.complete(mapBonjourError(error))
  }
}

private func mapBonjourError(
  _ error: DNSServiceErrorType
) -> CompanionBonjourRegistrationResult {
  if error == kDNSServiceErr_PolicyDenied || error == kDNSServiceErr_NoAuth {
    return .permissionDenied
  }
  return .unavailable
}

private func encodeTxtRecord(_ values: [String: String]) -> Data? {
  var data = Data()
  for key in ["schema", "capability", "deviceId", "fingerprint"] {
    guard let value = values[key] else { return nil }
    let field = Data("\(key)=\(value)".utf8)
    guard !field.isEmpty, field.count <= 255 else { return nil }
    data.append(UInt8(field.count))
    data.append(field)
  }
  return data
}
