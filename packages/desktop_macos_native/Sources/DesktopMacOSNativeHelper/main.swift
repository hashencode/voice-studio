import CaptureCore
import Foundation
import NativeSecurity
import SecureImport

private let protocolIdentity = "voice2text-macos-helper/v1"
private let encoder = JSONEncoder()
private let decoder = JSONDecoder()

struct Capabilities: Codable {
  let exactSourcePaths: [String]
  let destinationRoots: [String]
  let captureSessionRoot: String?
  let companionDiscovery: Bool?
}

struct CapturePreflightRequest: Codable {
  let minimumFreeBytes: Int64
  let captionModelAvailable: Bool
  let requestPermissions: Bool
}

struct CaptureStartRequest: Codable {
  let sessionId: String
  let minimumFreeBytes: Int64
  let microphoneDeviceId: String?
}

struct CaptureControlRequest: Codable {
  let sessionId: String
  let reason: String?
}

struct MicrophoneTestStartRequest: Codable {
  let testId: String
  let microphoneDeviceId: String?
}

struct MicrophoneTestControlRequest: Codable {
  let testId: String
}

struct SecretProviderRequest: Codable {
  let providerId: String
}

struct SecretReplaceRequest: Codable {
  let providerId: String
  let secret: String
}

struct CompanionCredentialRequest: Codable {
  let kind: String
  let peerDeviceId: String?
  let credentialBase64: String?
}

struct CompanionDiscoveryRegisterRequest: Codable {
  let userInitiated: Bool
  let port: Int
  let deviceId: String
  let deviceName: String
  let fingerprint: String
}

struct Handshake: Codable {
  let schemaVersion: Int
  let command: String
  let helperNonce: String
  let clientNonce: String
  let sessionId: String
  let capabilities: Capabilities
}

func emit(_ value: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func nonce() -> String {
  var generator = SystemRandomNumberGenerator()
  return (0..<32).map { _ in
    String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator))
  }.joined()
}

func readLine() -> Data? {
  var data = Data()
  while true {
    let byte = FileHandle.standardInput.readData(ofLength: 1)
    if byte.isEmpty { return data.isEmpty ? nil : data }
    if byte[0] == 0x0a { return data }
    guard data.count < 64 * 1024 else { return nil }
    data.append(byte)
  }
}

let helperNonce = nonce()
emit([
  "schemaVersion": 1,
  "type": "hello",
  "protocol": protocolIdentity,
  "transport": "inherited-stdio",
  "helperNonce": helperNonce,
])

guard let handshakeData = readLine(),
  let handshake = try? decoder.decode(Handshake.self, from: handshakeData),
  handshake.schemaVersion == 1,
  handshake.command == "handshake",
  handshake.helperNonce == helperNonce,
  handshake.clientNonce.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
  handshake.sessionId.range(of: #"^[a-zA-Z0-9-]{12,128}$"#, options: .regularExpression) != nil,
  handshake.capabilities.exactSourcePaths.count <= 32,
  handshake.capabilities.destinationRoots.count <= 8
else {
  emit([
    "schemaVersion": 1, "type": "error", "code": "HELPER_HANDSHAKE_REJECTED",
    "message": "helper handshake rejected",
  ])
  exit(64)
}

let exactSources = Set(
  handshake.capabilities.exactSourcePaths.map { URL(filePath: $0).standardizedFileURL.path })
let destinationRoots = Set(
  handshake.capabilities.destinationRoots.map { URL(filePath: $0).standardizedFileURL.path })
let captureController: CaptureController?
if let captureRoot = handshake.capabilities.captureSessionRoot {
  do {
    captureController = try CaptureController(captureRootPath: captureRoot)
  } catch {
    emit([
      "schemaVersion": 1, "type": "error", "code": "HELPER_HANDSHAKE_REJECTED",
      "message": "capture capability was invalid",
    ])
    exit(64)
  }
} else {
  captureController = nil
}
emit([
  "schemaVersion": 1,
  "type": "ready",
  "protocol": protocolIdentity,
  "transport": "inherited-stdio",
  "helperNonce": helperNonce,
  "clientNonce": handshake.clientNonce,
  "sessionId": handshake.sessionId,
])

func decodeRequest<T: Decodable>(_ type: T.Type, from object: [String: Any]) throws -> T {
  guard let raw = object["request"] as? [String: Any],
    JSONSerialization.isValidJSONObject(raw)
  else { throw CaptureFailure("CAPTURE_ARGUMENTS_INVALID", "capture arguments are invalid") }
  return try decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: raw))
}

func decodeSecurityRequest<T: Decodable>(_ type: T.Type, from object: [String: Any]) throws -> T {
  guard let raw = object["request"] as? [String: Any],
    JSONSerialization.isValidJSONObject(raw),
    let decoded = try? decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: raw))
  else {
    throw NativeSecurityFailure(
      "KEYCHAIN_ARGUMENTS_INVALID",
      "Keychain arguments are invalid"
    )
  }
  return decoded
}

func decodeCompanionRequest<T: Decodable>(
  _ type: T.Type,
  from object: [String: Any],
  code: String,
  message: String
) throws -> T {
  guard let raw = object["request"] as? [String: Any],
    JSONSerialization.isValidJSONObject(raw),
    let decoded = try? decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: raw))
  else { throw NativeSecurityFailure(code, message) }
  return decoded
}

func companionCredentialKey(_ request: CompanionCredentialRequest) throws
  -> CompanionCredentialKey
{
  switch request.kind {
  case "identity-seed":
    guard request.peerDeviceId == nil else {
      throw NativeSecurityFailure(
        "KEYCHAIN_ARGUMENTS_INVALID",
        "companion credential key is invalid"
      )
    }
    return .identitySeed
  case "peer-shared":
    guard let peerDeviceId = request.peerDeviceId else {
      throw NativeSecurityFailure(
        "KEYCHAIN_ARGUMENTS_INVALID",
        "companion credential key is invalid"
      )
    }
    return .peer(deviceId: peerDeviceId)
  default:
    throw NativeSecurityFailure(
      "KEYCHAIN_ARGUMENTS_INVALID",
      "companion credential key is invalid"
    )
  }
}

func companionDiscoveryReceiptObject(_ receipt: CompanionDiscoveryReceipt) -> [String: Any] {
  [
    "schemaVersion": receipt.schemaVersion,
    "state": receipt.state.rawValue,
    "serviceType": receipt.serviceType,
    "port": receipt.port ?? NSNull(),
    "registeredName": receipt.registeredName ?? NSNull(),
    "manualFallbackAvailable": receipt.manualFallbackAvailable,
  ]
}

func encodedObject<T: Encodable>(_ value: T) throws -> Any {
  try JSONSerialization.jsonObject(with: encoder.encode(value))
}

func emitSession(_ fields: [String: Any]) {
  var frame = fields
  frame["schemaVersion"] = 1
  frame["helperNonce"] = helperNonce
  frame["clientNonce"] = handshake.clientNonce
  frame["sessionId"] = handshake.sessionId
  emit(frame)
}

let captureCommands: Set<String> = [
  "capture-preflight", "capture-start", "capture-pause", "capture-resume",
  "capture-stop", "capture-snapshot", "capture-recover", "capture-discard",
  "capture-system-sleep", "capture-system-wake",
  "microphone-test-start", "microphone-test-snapshot", "microphone-test-finish",
  "microphone-test-cancel",
]
let securityCommands: Set<String> = [
  "secret-read", "secret-replace", "secret-delete", "filevault-status",
]
let companionCredentialCommands: Set<String> = [
  "companion-credential-read", "companion-credential-replace", "companion-credential-delete",
]
let companionDiscoveryCommands: Set<String> = [
  "companion-discovery-register", "companion-discovery-status", "companion-discovery-unregister",
]
let companionCommands = companionCredentialCommands.union(companionDiscoveryCommands)
let replayProtectedCommands = captureCommands.union(securityCommands).union(companionCommands)
let providerSecretStore = ProviderSecretStore()
let fileVaultStatusProbe = FileVaultStatusProbe()
let companionCredentialStore = CompanionCredentialStore()
let companionDiscovery = CompanionDiscoveryRegistrar()
var seenCommandIds = Set<String>()

while let commandData = readLine() {
  do {
    guard let object = try JSONSerialization.jsonObject(with: commandData) as? [String: Any],
      object["schemaVersion"] as? Int == 1,
      object["helperNonce"] as? String == helperNonce,
      object["clientNonce"] as? String == handshake.clientNonce,
      object["sessionId"] as? String == handshake.sessionId,
      let command = object["command"] as? String
    else {
      throw SecureImportFailure("HELPER_SESSION_REJECTED", "helper session identity rejected")
    }
    if replayProtectedCommands.contains(command) {
      guard let commandId = object["commandId"] as? String,
        commandId.range(of: #"^[a-zA-Z0-9-]{12,160}$"#, options: .regularExpression) != nil
      else {
        throw SecureImportFailure(
          "HELPER_CAPABILITY_DENIED",
          "command receipt is missing"
        )
      }
      if captureCommands.contains(command), captureController == nil {
        throw CaptureFailure(
          "HELPER_CAPABILITY_DENIED",
          "capture capability is missing"
        )
      }
      if companionDiscoveryCommands.contains(command),
        handshake.capabilities.companionDiscovery != true
      {
        throw NativeSecurityFailure(
          "HELPER_CAPABILITY_DENIED",
          "companion discovery capability is missing"
        )
      }
      guard !seenCommandIds.contains(commandId) else {
        throw SecureImportFailure(
          "HELPER_COMMAND_REPLAYED",
          "helper command was replayed"
        )
      }
      guard seenCommandIds.count < 4_096 else {
        throw SecureImportFailure(
          "HELPER_SESSION_LIMIT_EXCEEDED",
          "helper command receipt limit was reached"
        )
      }
      seenCommandIds.insert(commandId)
    }
    switch command {
    case "secure-import":
      guard let requestObject = object["request"] as? [String: Any],
        JSONSerialization.isValidJSONObject(requestObject)
      else { throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "导入参数无效") }
      let requestData = try JSONSerialization.data(withJSONObject: requestObject)
      let request = try decoder.decode(SecureImportRequest.self, from: requestData)
      guard exactSources.contains(URL(filePath: request.sourcePath).standardizedFileURL.path),
        destinationRoots.contains(URL(filePath: request.destinationRoot).standardizedFileURL.path)
      else {
        throw SecureImportFailure(
          "HELPER_CAPABILITY_DENIED", "path is outside the session capability")
      }
      let receipt = try SecureImporter().importMedia(request)
      let receiptObject = try JSONSerialization.jsonObject(with: encoder.encode(receipt))
      emitSession(["type": "result", "command": command, "receipt": receiptObject])
    case "discard-import":
      guard let path = object["path"] as? String,
        let root = object["destinationRoot"] as? String,
        destinationRoots.contains(URL(filePath: root).standardizedFileURL.path)
      else {
        throw SecureImportFailure(
          "HELPER_CAPABILITY_DENIED", "path is outside the session capability")
      }
      try discardSecureImportedFile(path: path, destinationRoot: root)
      emitSession(["type": "result", "command": command])
    case "cleanup-import-temporary":
      guard let root = object["destinationRoot"] as? String,
        destinationRoots.contains(URL(filePath: root).standardizedFileURL.path)
      else {
        throw SecureImportFailure(
          "HELPER_CAPABILITY_DENIED", "path is outside the session capability")
      }
      let removed = try cleanupSecureImportTemporaryFiles(destinationRoot: root)
      emitSession(["type": "result", "command": command, "removed": removed])
    case "capture-preflight":
      let request = try decodeRequest(CapturePreflightRequest.self, from: object)
      let value = try captureController!.preflight(
        minimumFreeBytes: request.minimumFreeBytes,
        captionModelAvailable: request.captionModelAvailable,
        requestPermissions: request.requestPermissions
      )
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-start":
      let request = try decodeRequest(CaptureStartRequest.self, from: object)
      let value = try captureController!.start(
        sessionId: request.sessionId,
        minimumFreeBytes: request.minimumFreeBytes,
        microphoneDeviceId: request.microphoneDeviceId
      )
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-pause", "capture-system-sleep":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      let value = try captureController!.pause(
        sessionId: request.sessionId,
        reason: command == "capture-system-sleep" ? "system_sleep" : request.reason
      )
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-resume":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      let value = try captureController!.resume(sessionId: request.sessionId)
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-system-wake":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      let value = try captureController!.markWake(sessionId: request.sessionId)
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-stop":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      let value = try captureController!.stop(sessionId: request.sessionId)
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-snapshot":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      let value = try captureController!.currentSnapshot(sessionId: request.sessionId)
      emitSession(["type": "result", "command": command, "capture": try encodedObject(value)])
    case "capture-recover":
      let values = try captureController!.recover()
      emitSession(["type": "result", "command": command, "captures": try encodedObject(values)])
    case "capture-discard":
      let request = try decodeRequest(CaptureControlRequest.self, from: object)
      try captureController!.discard(sessionId: request.sessionId)
      emitSession(["type": "result", "command": command])
    case "microphone-test-start":
      let request = try decodeRequest(MicrophoneTestStartRequest.self, from: object)
      let value = try captureController!.startMicrophoneTest(
        testId: request.testId,
        microphoneDeviceId: request.microphoneDeviceId
      )
      emitSession(["type": "result", "command": command, "microphoneTest": try encodedObject(value)])
    case "microphone-test-snapshot":
      let request = try decodeRequest(MicrophoneTestControlRequest.self, from: object)
      let value = try captureController!.microphoneTestSnapshot(testId: request.testId)
      emitSession(["type": "result", "command": command, "microphoneTest": try encodedObject(value)])
    case "microphone-test-finish":
      let request = try decodeRequest(MicrophoneTestControlRequest.self, from: object)
      let value = try captureController!.finishMicrophoneTest(testId: request.testId)
      emitSession(["type": "result", "command": command, "microphoneTest": try encodedObject(value)])
    case "microphone-test-cancel":
      let request = try decodeRequest(MicrophoneTestControlRequest.self, from: object)
      let value = try captureController!.cancelMicrophoneTest(testId: request.testId)
      emitSession(["type": "result", "command": command, "microphoneTest": try encodedObject(value)])
    case "secret-read":
      let request = try decodeSecurityRequest(SecretProviderRequest.self, from: object)
      let value = try providerSecretStore.read(providerId: request.providerId)
      let receipt: [String: Any]
      switch value {
      case .available(let secret):
        receipt = ["schemaVersion": 1, "state": "available", "secret": secret]
      case .missing:
        receipt = ["schemaVersion": 1, "state": "missing"]
      case .denied:
        receipt = ["schemaVersion": 1, "state": "denied"]
      case .corrupt:
        receipt = ["schemaVersion": 1, "state": "corrupt"]
      }
      emitSession(["type": "result", "command": command, "secret": receipt])
    case "secret-replace":
      let request = try decodeSecurityRequest(SecretReplaceRequest.self, from: object)
      let state = try providerSecretStore.replace(
        providerId: request.providerId,
        secret: request.secret
      )
      emitSession([
        "type": "result",
        "command": command,
        "secret": ["schemaVersion": 1, "state": state.rawValue],
      ])
    case "secret-delete":
      let request = try decodeSecurityRequest(SecretProviderRequest.self, from: object)
      let state = try providerSecretStore.delete(providerId: request.providerId)
      emitSession([
        "type": "result",
        "command": command,
        "secret": ["schemaVersion": 1, "state": state.rawValue],
      ])
    case "filevault-status":
      emitSession([
        "type": "result",
        "command": command,
        "security": try encodedObject(fileVaultStatusProbe.status()),
      ])
    case "companion-credential-read":
      let request = try decodeCompanionRequest(
        CompanionCredentialRequest.self,
        from: object,
        code: "KEYCHAIN_ARGUMENTS_INVALID",
        message: "companion credential arguments are invalid"
      )
      let value = try companionCredentialStore.read(companionCredentialKey(request))
      let receipt: [String: Any]
      switch value {
      case .available(let credential):
        receipt = [
          "schemaVersion": 1,
          "state": "available",
          "credentialBase64": credential.base64EncodedString(),
        ]
      case .missing:
        receipt = ["schemaVersion": 1, "state": "missing"]
      case .denied:
        receipt = ["schemaVersion": 1, "state": "denied"]
      case .corrupt:
        receipt = ["schemaVersion": 1, "state": "corrupt"]
      }
      emitSession([
        "type": "result", "command": command, "companionCredential": receipt,
      ])
    case "companion-credential-replace":
      let request = try decodeCompanionRequest(
        CompanionCredentialRequest.self,
        from: object,
        code: "KEYCHAIN_ARGUMENTS_INVALID",
        message: "companion credential arguments are invalid"
      )
      guard let encoded = request.credentialBase64,
        let credential = Data(base64Encoded: encoded),
        credential.count == 32,
        credential.base64EncodedString() == encoded
      else {
        throw NativeSecurityFailure(
          "KEYCHAIN_ARGUMENTS_INVALID",
          "companion credential encoding is invalid"
        )
      }
      let state = try companionCredentialStore.replace(
        companionCredentialKey(request),
        credential: credential
      )
      emitSession([
        "type": "result",
        "command": command,
        "companionCredential": ["schemaVersion": 1, "state": state.rawValue],
      ])
    case "companion-credential-delete":
      let request = try decodeCompanionRequest(
        CompanionCredentialRequest.self,
        from: object,
        code: "KEYCHAIN_ARGUMENTS_INVALID",
        message: "companion credential arguments are invalid"
      )
      let state = try companionCredentialStore.delete(companionCredentialKey(request))
      emitSession([
        "type": "result",
        "command": command,
        "companionCredential": ["schemaVersion": 1, "state": state.rawValue],
      ])
    case "companion-discovery-register":
      let request = try decodeCompanionRequest(
        CompanionDiscoveryRegisterRequest.self,
        from: object,
        code: "COMPANION_DISCOVERY_ARGUMENTS_INVALID",
        message: "companion discovery arguments are invalid"
      )
      let receipt = try companionDiscovery.register(
        CompanionDiscoveryRequest(
          userInitiated: request.userInitiated,
          port: request.port,
          deviceId: request.deviceId,
          deviceName: request.deviceName,
          fingerprint: request.fingerprint
        )
      )
      emitSession([
        "type": "result",
        "command": command,
        "companionDiscovery": companionDiscoveryReceiptObject(receipt),
      ])
    case "companion-discovery-unregister":
      emitSession([
        "type": "result",
        "command": command,
        "companionDiscovery": companionDiscoveryReceiptObject(companionDiscovery.unregister()),
      ])
    case "companion-discovery-status":
      emitSession([
        "type": "result",
        "command": command,
        "companionDiscovery": companionDiscoveryReceiptObject(companionDiscovery.status()),
      ])
    default:
      throw SecureImportFailure(
        "HELPER_COMMAND_NOT_ALLOWLISTED", "helper command is not allowlisted")
    }
  } catch let failure as SecureImportFailure {
    emitSession(["type": "error", "code": failure.code, "message": failure.message])
  } catch let failure as CaptureFailure {
    emitSession(["type": "error", "code": failure.code, "message": failure.message])
  } catch let failure as NativeSecurityFailure {
    emitSession(["type": "error", "code": failure.code, "message": failure.message])
  } catch {
    emitSession([
      "type": "error", "code": "HELPER_REQUEST_INVALID", "message": "helper request was invalid",
    ])
  }
}

_ = companionDiscovery.unregister()
