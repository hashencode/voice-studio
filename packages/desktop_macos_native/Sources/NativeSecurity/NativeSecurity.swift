import Darwin
import Foundation
import LocalAuthentication
import Security

public struct NativeSecurityFailure: Error, Codable, Equatable, Sendable {
  public let code: String
  public let message: String

  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

public enum KeychainAccessibility: Sendable {
  case whenUnlockedThisDeviceOnly
}

public enum KeychainReadResult: Equatable, Sendable {
  case value(Data)
  case missing
  case denied
  case unavailable
  case failure(Int32)
}

public enum KeychainReplaceResult: Equatable, Sendable {
  case stored
  case denied
  case unavailable
  case failure(Int32)
}

public enum KeychainDeleteResult: Equatable, Sendable {
  case deleted
  case missing
  case denied
  case unavailable
  case failure(Int32)
}

public protocol KeychainBackend: AnyObject {
  func read(service: String, account: String) -> KeychainReadResult
  func replace(
    service: String,
    account: String,
    value: Data,
    accessibility: KeychainAccessibility,
    synchronizable: Bool,
    usesDataProtectionKeychain: Bool
  ) -> KeychainReplaceResult
  func delete(service: String, account: String) -> KeychainDeleteResult
}

public final class SystemKeychainBackend: KeychainBackend, @unchecked Sendable {
  public init() {}

  public func read(service: String, account: String) -> KeychainReadResult {
    var item: CFTypeRef?
    var query = baseQuery(service: service, account: account)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data else { return .failure(errSecDecode) }
      return .value(data)
    case errSecItemNotFound:
      return .missing
    default:
      return mapReadFailure(status)
    }
  }

  public func replace(
    service: String,
    account: String,
    value: Data,
    accessibility: KeychainAccessibility,
    synchronizable: Bool,
    usesDataProtectionKeychain: Bool
  ) -> KeychainReplaceResult {
    let query = baseQuery(service: service, account: account)
    let update: [CFString: Any] = [
      kSecValueData: value,
      kSecAttrAccessible: securityAccessibility(accessibility),
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess { return .stored }
    if updateStatus != errSecItemNotFound { return mapReplaceFailure(updateStatus) }

    var addition = query
    addition[kSecValueData] = value
    addition[kSecAttrAccessible] = securityAccessibility(accessibility)
    addition[kSecAttrSynchronizable] = synchronizable
    if usesDataProtectionKeychain {
      addition[kSecUseDataProtectionKeychain] = true
    }
    let addStatus = SecItemAdd(addition as CFDictionary, nil)
    return addStatus == errSecSuccess
      ? .stored
      : mapReplaceFailure(addStatus)
  }

  public func delete(service: String, account: String) -> KeychainDeleteResult {
    let status = SecItemDelete(
      baseQuery(service: service, account: account) as CFDictionary
    )
    switch status {
    case errSecSuccess:
      return .deleted
    case errSecItemNotFound:
      return .missing
    default:
      return mapDeleteFailure(status)
    }
  }

  private func baseQuery(service: String, account: String) -> [CFString: Any] {
    let authenticationContext = LAContext()
    authenticationContext.interactionNotAllowed = true
    return [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
      kSecUseDataProtectionKeychain: true,
      kSecUseAuthenticationContext: authenticationContext,
    ]
  }
}

public enum ProviderSecretRead: Equatable, Sendable {
  case available(String)
  case missing
  case denied
  case corrupt
}

public enum ProviderSecretMutationState: String, Codable, Equatable, Sendable {
  case stored
  case deleted
  case missing
  case denied
}

public final class ProviderSecretStore: @unchecked Sendable {
  public static let service = "com.voice2text.desktop.audio-ai"
  private static let legacyService = "com.voice2text.desktop.meeting-ai"
  private let backend: KeychainBackend

  public init(backend: KeychainBackend = SystemKeychainBackend()) {
    self.backend = backend
  }

  public func read(providerId: String) throws -> ProviderSecretRead {
    let account = try account(providerId: providerId)
    switch backend.read(service: Self.service, account: account) {
    case .value(let data):
      return decode(data)
    case .missing:
      return try migrateLegacySecret(account: account)
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

  private func migrateLegacySecret(account: String) throws -> ProviderSecretRead {
    switch backend.read(service: Self.legacyService, account: account) {
    case .value(let data):
      let result = decode(data)
      guard case .available(let secret) = result else { return result }
      switch backend.replace(
        service: Self.service,
        account: account,
        value: Data(secret.utf8),
        accessibility: .whenUnlockedThisDeviceOnly,
        synchronizable: false,
        usesDataProtectionKeychain: true
      ) {
      case .stored:
        break
      case .denied:
        throw NativeSecurityFailure("KEYCHAIN_ACCESS_DENIED", "Keychain access was denied")
      case .unavailable:
        throw NativeSecurityFailure("KEYCHAIN_UNAVAILABLE", "Keychain is unavailable")
      case .failure:
        throw NativeSecurityFailure("KEYCHAIN_OPERATION_FAILED", "Keychain write failed")
      }
      switch backend.delete(service: Self.legacyService, account: account) {
      case .deleted, .missing:
        return .available(secret)
      case .denied:
        throw NativeSecurityFailure("KEYCHAIN_ACCESS_DENIED", "Keychain access was denied")
      case .unavailable:
        throw NativeSecurityFailure("KEYCHAIN_UNAVAILABLE", "Keychain is unavailable")
      case .failure:
        throw NativeSecurityFailure("KEYCHAIN_OPERATION_FAILED", "Keychain delete failed")
      }
    case .missing:
      return .missing
    case .denied:
      return .denied
    case .unavailable:
      throw NativeSecurityFailure("KEYCHAIN_UNAVAILABLE", "Keychain is unavailable")
    case .failure:
      throw NativeSecurityFailure("KEYCHAIN_OPERATION_FAILED", "Keychain read failed")
    }
  }

  private func decode(_ data: Data) -> ProviderSecretRead {
    guard
      !data.isEmpty,
      data.count <= 4_096,
      let secret = String(data: data, encoding: .utf8),
      !secret.isEmpty
    else { return .corrupt }
    return .available(secret)
  }

  public func replace(
    providerId: String,
    secret: String
  ) throws -> ProviderSecretMutationState {
    let account = try account(providerId: providerId)
    let normalized = secret.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, normalized.utf8.count <= 4_096 else {
      throw NativeSecurityFailure(
        "KEYCHAIN_ARGUMENTS_INVALID",
        "provider secret is invalid"
      )
    }
    switch backend.replace(
      service: Self.service,
      account: account,
      value: Data(normalized.utf8),
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

  public func delete(providerId: String) throws -> ProviderSecretMutationState {
    let account = try account(providerId: providerId)
    switch backend.delete(service: Self.service, account: account) {
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

  private func account(providerId: String) throws -> String {
    guard
      providerId.range(
        of: #"^[a-z0-9][a-z0-9._-]{1,63}$"#,
        options: .regularExpression
      ) != nil
    else {
      throw NativeSecurityFailure(
        "KEYCHAIN_ARGUMENTS_INVALID",
        "provider identifier is invalid"
      )
    }
    return "provider.\(providerId).api-key"
  }
}

public struct ProcessReceipt: Equatable, Sendable {
  public let exitCode: Int32
  public let stdout: String
  public let stderr: String

  public init(exitCode: Int32, stdout: String, stderr: String) {
    self.exitCode = exitCode
    self.stdout = stdout
    self.stderr = stderr
  }
}

struct BoundedProcessRunner: Sendable {
  let executableURL: URL
  let deadlineSeconds: TimeInterval
  let outputLimit: Int

  init(
    executableURL: URL,
    deadlineSeconds: TimeInterval = 5,
    outputLimit: Int = 4_096
  ) {
    self.executableURL = executableURL
    self.deadlineSeconds = deadlineSeconds
    self.outputLimit = outputLimit
  }

  func run(arguments: [String]) throws -> ProcessReceipt {
    let process = Process()
    let output = Pipe()
    let error = Pipe()
    let exited = DispatchSemaphore(value: 0)
    process.executableURL = executableURL
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = error
    process.terminationHandler = { _ in exited.signal() }
    try process.run()

    let outputGroup = DispatchGroup()
    let outputQueue = DispatchQueue(
      label: "com.voice2text.native-security.process-output",
      attributes: .concurrent
    )
    let stdout = LockedData()
    let stderr = LockedData()
    outputGroup.enter()
    outputQueue.async {
      stdout.store(drain(output.fileHandleForReading, keeping: outputLimit))
      outputGroup.leave()
    }
    outputGroup.enter()
    outputQueue.async {
      stderr.store(drain(error.fileHandleForReading, keeping: outputLimit))
      outputGroup.leave()
    }

    let deadline = DispatchTime.now() + deadlineSeconds
    guard exited.wait(timeout: deadline) == .success else {
      process.terminate()
      if exited.wait(timeout: .now() + 1) == .timedOut, process.isRunning {
        kill(process.processIdentifier, SIGKILL)
        _ = exited.wait(timeout: .now() + 1)
      }
      _ = outputGroup.wait(timeout: .now() + 1)
      throw CocoaError(.executableLoad)
    }
    guard outputGroup.wait(timeout: .now() + 1) == .success else {
      throw CocoaError(.fileReadTooLarge)
    }
    return ProcessReceipt(
      exitCode: process.terminationStatus,
      stdout: String(decoding: stdout.load(), as: UTF8.self),
      stderr: String(decoding: stderr.load(), as: UTF8.self)
    )
  }
}

public enum FileVaultState: String, Codable, Equatable, Sendable {
  case enabled
  case disabled
  case unknown
}

public struct FileVaultStatusReceipt: Encodable, Equatable, Sendable {
  public let schemaVersion = 1
  public let kind = "device-security"
  public let capability = "filevault"
  public let state: FileVaultState
  public let applicationLayerEncryption = "not-claimed"

  public init(state: FileVaultState) {
    self.state = state
  }
}

public struct FileVaultStatusProbe: Sendable {
  private let runner: @Sendable ([String]) throws -> ProcessReceipt

  public init() {
    runner = Self.run
  }

  public init(
    runner: @escaping @Sendable ([String]) throws -> ProcessReceipt
  ) {
    self.runner = runner
  }

  public func status() -> FileVaultStatusReceipt {
    do {
      let result = try runner(["status"])
      let output = "\(result.stdout)\n\(result.stderr)".lowercased()
      if result.exitCode == 0, output.contains("filevault is on") {
        return FileVaultStatusReceipt(state: .enabled)
      }
      if output.contains("filevault is off") {
        return FileVaultStatusReceipt(state: .disabled)
      }
    } catch {}
    return FileVaultStatusReceipt(state: .unknown)
  }

  private static func run(arguments: [String]) throws -> ProcessReceipt {
    try BoundedProcessRunner(
      executableURL: URL(filePath: "/usr/bin/fdesetup")
    ).run(arguments: arguments)
  }
}

private func drain(_ handle: FileHandle, keeping limit: Int) -> Data {
  var kept = Data()
  while true {
    let chunk = handle.readData(ofLength: 4_096)
    if chunk.isEmpty { return kept }
    if kept.count < limit {
      kept.append(chunk.prefix(limit - kept.count))
    }
  }
}

private final class LockedData: @unchecked Sendable {
  private let lock = NSLock()
  private var value = Data()

  func store(_ value: Data) {
    lock.lock()
    self.value = value
    lock.unlock()
  }

  func load() -> Data {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

private func securityAccessibility(_ value: KeychainAccessibility) -> CFString {
  switch value {
  case .whenUnlockedThisDeviceOnly:
    return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  }
}

private func isDenied(_ status: OSStatus) -> Bool {
  status == errSecAuthFailed || status == errSecInteractionNotAllowed
    || status == errSecUserCanceled
}

private func mapReadFailure(_ status: OSStatus) -> KeychainReadResult {
  if isDenied(status) { return .denied }
  if status == errSecNotAvailable { return .unavailable }
  return .failure(status)
}

private func mapReplaceFailure(_ status: OSStatus) -> KeychainReplaceResult {
  if isDenied(status) { return .denied }
  if status == errSecNotAvailable { return .unavailable }
  return .failure(status)
}

private func mapDeleteFailure(_ status: OSStatus) -> KeychainDeleteResult {
  if isDenied(status) { return .denied }
  if status == errSecNotAvailable { return .unavailable }
  return .failure(status)
}
