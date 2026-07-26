import Foundation
import FlutterMacOS

final class CompanionDiscoveryPlugin: NSObject, NetServiceDelegate {
  private let channel: FlutterMethodChannel
  private var service: NetService?
  private var pendingRegistration: FlutterResult?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(
      name: "voice2text/desktop_companion",
      binaryMessenger: messenger
    )
    super.init()
    channel.setMethodCallHandler(handle)
  }

  func dispose() {
    service?.stop()
    service = nil
    pendingRegistration = nil
    channel.setMethodCallHandler(nil)
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "register":
      guard
        let arguments = call.arguments as? [String: Any],
        let port = arguments["port"] as? Int,
        (1...65535).contains(port),
        let deviceId = bounded(arguments["deviceId"], maximum: 128),
        let deviceName = bounded(arguments["deviceName"], maximum: 80),
        let fingerprint = bounded(arguments["fingerprint"], maximum: 64)
      else {
        result(
          FlutterError(
            code: "COMPANION_INVALID_ARGUMENT",
            message: "DNS-SD registration arguments are invalid",
            details: nil
          )
        )
        return
      }
      service?.stop()
      pendingRegistration = result
      let next = NetService(
        domain: "local.",
        type: "_voice2text-media._tcp.",
        name: deviceName,
        port: Int32(port)
      )
      next.delegate = self
      next.setTXTRecord(
        NetService.data(fromTXTRecord: [
          "schema": Data("companion-media-transfer/v1".utf8),
          "capability": Data("media-transfer/v1".utf8),
          "deviceId": Data(deviceId.utf8),
          "fingerprint": Data(fingerprint.utf8),
        ])
      )
      service = next
      next.publish()
    case "unregister":
      service?.stop()
      service = nil
      pendingRegistration = nil
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func netServiceDidPublish(_ sender: NetService) {
    pendingRegistration?([
      "registered": true,
      "name": sender.name,
      "port": sender.port,
    ])
    pendingRegistration = nil
  }

  func netService(
    _ sender: NetService,
    didNotPublish errorDict: [String: NSNumber]
  ) {
    pendingRegistration?(
      FlutterError(
        code: "COMPANION_DNSSD_FAILED",
        message: "The LAN receiver could not be advertised",
        details: ["domain": sender.domain, "type": sender.type]
      )
    )
    pendingRegistration = nil
    service = nil
  }

  private func bounded(_ raw: Any?, maximum: Int) -> String? {
    guard let value = raw as? String else { return nil }
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      !normalized.isEmpty,
      normalized.count <= maximum,
      normalized.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
    else {
      return nil
    }
    return normalized
  }
}
