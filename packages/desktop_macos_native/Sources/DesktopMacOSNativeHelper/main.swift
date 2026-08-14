import Foundation
import SecureImport

private let protocolIdentity = "voice2text-macos-helper/v1"
private let encoder = JSONEncoder()
private let decoder = JSONDecoder()

struct Capabilities: Codable {
  let exactSourcePaths: [String]
  let destinationRoots: [String]
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
  return (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
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
  emit(["schemaVersion": 1, "type": "error", "code": "HELPER_HANDSHAKE_REJECTED", "message": "helper handshake rejected"])
  exit(64)
}

let exactSources = Set(handshake.capabilities.exactSourcePaths.map { URL(filePath: $0).standardizedFileURL.path })
let destinationRoots = Set(handshake.capabilities.destinationRoots.map { URL(filePath: $0).standardizedFileURL.path })
emit([
  "schemaVersion": 1,
  "type": "ready",
  "protocol": protocolIdentity,
  "transport": "inherited-stdio",
  "helperNonce": helperNonce,
  "clientNonce": handshake.clientNonce,
  "sessionId": handshake.sessionId,
])

func emitSession(_ fields: [String: Any]) {
  var frame = fields
  frame["schemaVersion"] = 1
  frame["helperNonce"] = helperNonce
  frame["clientNonce"] = handshake.clientNonce
  frame["sessionId"] = handshake.sessionId
  emit(frame)
}

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
        throw SecureImportFailure("HELPER_CAPABILITY_DENIED", "path is outside the session capability")
      }
      let receipt = try SecureImporter().importMedia(request)
      let receiptObject = try JSONSerialization.jsonObject(with: encoder.encode(receipt))
      emitSession(["type": "result", "command": command, "receipt": receiptObject])
    case "discard-import":
      guard let path = object["path"] as? String,
        let root = object["destinationRoot"] as? String,
        destinationRoots.contains(URL(filePath: root).standardizedFileURL.path)
      else { throw SecureImportFailure("HELPER_CAPABILITY_DENIED", "path is outside the session capability") }
      try discardSecureImportedFile(path: path, destinationRoot: root)
      emitSession(["type": "result", "command": command])
    case "cleanup-import-temporary":
      guard let root = object["destinationRoot"] as? String,
        destinationRoots.contains(URL(filePath: root).standardizedFileURL.path)
      else { throw SecureImportFailure("HELPER_CAPABILITY_DENIED", "path is outside the session capability") }
      let removed = try cleanupSecureImportTemporaryFiles(destinationRoot: root)
      emitSession(["type": "result", "command": command, "removed": removed])
    default:
      throw SecureImportFailure("HELPER_COMMAND_NOT_ALLOWLISTED", "helper command is not allowlisted")
    }
  } catch let failure as SecureImportFailure {
    emitSession(["type": "error", "code": failure.code, "message": failure.message])
  } catch {
    emitSession(["type": "error", "code": "HELPER_REQUEST_INVALID", "message": "helper request was invalid"])
  }
}
