import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

enum DesktopMicrophoneCaptureError: Error {
  case permissionDenied
  case noInputDevice
  case selectedInputUnavailable
  case selectedInputFailed(OSStatus)
  case invalidFormat
  case engineStart(Error)
}

final class MicrophoneCapture {
  private let engine = AVAudioEngine()
  private(set) var observedFrames: UInt64 = 0
  private(set) var deliveredFrames: UInt64 = 0
  private(set) var sampleRate: Double = 0
  private(set) var channelCount: UInt32 = 0
  private(set) var normalizedPeak: Double = 0
  private(set) var format: AVAudioFormat?
  private var bufferHandler: ((AVAudioPCMBuffer) -> Void)?
  private var healthHandler: ((String) -> Void)?
  private var installedTap = false
  private var configurationObserver: NSObjectProtocol?
  private let selectedDeviceUniqueID: String?

  init(
    selectedDeviceUniqueID: String? = nil,
    bufferHandler: ((AVAudioPCMBuffer) -> Void)? = nil,
    healthHandler: ((String) -> Void)? = nil
  ) {
    self.selectedDeviceUniqueID = selectedDeviceUniqueID
    self.bufferHandler = bufferHandler
    self.healthHandler = healthHandler
  }

  func setBufferHandler(_ handler: ((AVAudioPCMBuffer) -> Void)?) {
    bufferHandler = handler
  }

  static func permissionWireState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .notDetermined:
      return "not_determined"
    case .authorized:
      return "granted"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    @unknown default:
      return "unavailable"
    }
  }

  static func requestPermission(_ completion: @escaping (Bool) -> Void) {
    AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
  }

  static func devices() -> [[String: Any]] {
    let deviceTypes: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
      deviceTypes = [.microphone, .external]
    } else {
      deviceTypes = [.builtInMicrophone, .externalUnknown]
    }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: deviceTypes,
      mediaType: .audio,
      position: .unspecified
    )
    let defaultID = AVCaptureDevice.default(for: .audio)?.uniqueID
    return discovery.devices.compactMap { device in
      guard audioDeviceID(uniqueID: device.uniqueID) != nil else {
        return nil
      }
      return [
        "id": device.uniqueID,
        "name": device.localizedName,
        "isDefault": device.uniqueID == defaultID,
      ]
    }
  }

  func start() throws {
    if engine.isRunning { return }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      throw DesktopMicrophoneCaptureError.permissionDenied
    }
    let input = engine.inputNode
    try selectInputDeviceIfNeeded(input)
    let format = input.inputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw DesktopMicrophoneCaptureError.invalidFormat
    }
    sampleRate = format.sampleRate
    channelCount = format.channelCount
    self.format = format
    if !installedTap {
      input.installTap(
        onBus: 0,
        bufferSize: 1024,
        format: format
      ) { [weak self] buffer, _ in
        guard let self else { return }
        self.observedFrames &+= UInt64(buffer.frameLength)
        self.normalizedPeak = Self.peak(buffer)
        guard let handler = self.bufferHandler,
          let copy = CaptureChunkJournal.clone(buffer)
        else {
          return
        }
        self.deliveredFrames &+= UInt64(copy.frameLength)
        handler(copy)
      }
      installedTap = true
    }
    engine.prepare()
    do {
      try engine.start()
      if configurationObserver == nil {
        configurationObserver = NotificationCenter.default.addObserver(
          forName: .AVAudioEngineConfigurationChange,
          object: engine,
          queue: nil
        ) { [weak self] _ in
          guard let self else { return }
          let next = self.engine.inputNode.inputFormat(forBus: 0)
          if self.engine.isRunning,
            next.sampleRate == self.sampleRate,
            next.channelCount == self.channelCount
          {
            return
          }
          self.healthHandler?("audio_engine_configuration_changed")
        }
      }
    } catch {
      throw DesktopMicrophoneCaptureError.engineStart(error)
    }
  }

  private func selectInputDeviceIfNeeded(_ input: AVAudioInputNode) throws {
    guard let selectedDeviceUniqueID else { return }
    guard
      let deviceID = Self.audioDeviceID(uniqueID: selectedDeviceUniqueID)
    else {
      throw DesktopMicrophoneCaptureError.selectedInputUnavailable
    }
    guard let audioUnit = input.audioUnit else {
      throw DesktopMicrophoneCaptureError.selectedInputUnavailable
    }
    var mutableDeviceID = deviceID
    let status = AudioUnitSetProperty(
      audioUnit,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global,
      0,
      &mutableDeviceID,
      UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    guard status == noErr else {
      throw DesktopMicrophoneCaptureError.selectedInputFailed(status)
    }
  }

  private static func audioDeviceID(uniqueID: String) -> AudioDeviceID? {
    var devicesAddress = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var devicesSize: UInt32 = 0
    guard
      AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &devicesAddress,
        0,
        nil,
        &devicesSize
      ) == noErr
    else {
      return nil
    }
    let count = Int(devicesSize) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](
      repeating: AudioDeviceID(kAudioObjectUnknown),
      count: count
    )
    guard
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &devicesAddress,
        0,
        nil,
        &devicesSize,
        &devices
      ) == noErr
    else {
      return nil
    }
    for deviceID in devices {
      var uidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      var value: CFString = "" as CFString
      var valueSize = UInt32(MemoryLayout<CFString>.size)
      let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(
          deviceID,
          &uidAddress,
          0,
          nil,
          &valueSize,
          pointer
        )
      }
      if status == noErr, value as String == uniqueID {
        return deviceID
      }
    }
    return nil
  }

  private static func peak(_ buffer: AVAudioPCMBuffer) -> Double {
    let frameCount = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    guard frameCount > 0, channelCount > 0 else { return 0 }
    var peak: Float = 0
    if let channels = buffer.floatChannelData {
      for channel in 0..<channelCount {
        for frame in 0..<frameCount {
          peak = max(peak, abs(channels[channel][frame]))
        }
      }
      return min(1, max(0, Double(peak)))
    }
    if let channels = buffer.int16ChannelData {
      var integerPeak: Int32 = 0
      for channel in 0..<channelCount {
        for frame in 0..<frameCount {
          integerPeak = max(
            integerPeak,
            abs(Int32(channels[channel][frame]))
          )
        }
      }
      return min(1, Double(integerPeak) / Double(Int16.max))
    }
    return 0
  }

  func pause() {
    if engine.isRunning {
      engine.pause()
    }
  }

  func teardown() {
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
      self.configurationObserver = nil
    }
    engine.stop()
    if installedTap {
      engine.inputNode.removeTap(onBus: 0)
      installedTap = false
    }
  }
}
