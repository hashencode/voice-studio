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

struct CoreAudioInputDevice {
  let audioDeviceID: AudioDeviceID
  let uniqueID: String
  let name: String
}

final class MicrophoneCapture {
  struct MeterSnapshot {
    let observedFrames: UInt64
    let normalizedPeak: Double
  }

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
  private let meterLock = NSLock()

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

  static func devices() -> [CaptureDevice] {
    captureDevices(
      from: coreAudioInputDevices(),
      defaultAudioDeviceID: defaultInputAudioDeviceID()
    )
  }

  static func captureDevices(
    from devices: [CoreAudioInputDevice],
    defaultAudioDeviceID: AudioDeviceID?
  ) -> [CaptureDevice] {
    devices.map { device in
      CaptureDevice(
        id: device.uniqueID,
        name: device.name,
        isDefault: device.audioDeviceID == defaultAudioDeviceID
      )
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
        self.meterLock.lock()
        self.observedFrames &+= UInt64(buffer.frameLength)
        self.normalizedPeak = Self.peak(buffer)
        self.meterLock.unlock()
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

  func meterSnapshot() -> MeterSnapshot {
    meterLock.lock()
    defer { meterLock.unlock() }
    return MeterSnapshot(
      observedFrames: observedFrames,
      normalizedPeak: normalizedPeak
    )
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
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var uid = uniqueID as CFString
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var resultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = withUnsafePointer(to: &uid) { pointer in
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        UInt32(MemoryLayout<CFString>.size),
        pointer,
        &resultSize,
        &deviceID
      )
    }
    guard status == noErr, deviceID != kAudioObjectUnknown else { return nil }
    return deviceID
  }

  private static func coreAudioInputDevices() -> [CoreAudioInputDevice] {
    allAudioDeviceIDs().compactMap { deviceID in
      guard hasInputStreams(deviceID),
        let id = deviceUID(deviceID),
        let name = deviceName(deviceID)
      else {
        return nil
      }
      return CoreAudioInputDevice(
        audioDeviceID: deviceID,
        uniqueID: id,
        name: name
      )
    }
  }

  private static func defaultInputAudioDeviceID() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultInputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      0,
      nil,
      &size,
      &deviceID
    ) == noErr else {
      return nil
    }
    return deviceID == kAudioObjectUnknown ? nil : deviceID
  }

  private static func allAudioDeviceIDs() -> [AudioDeviceID] {
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
      return []
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
      return []
    }
    return devices
  }

  private static func hasInputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(
      deviceID,
      &address,
      0,
      nil,
      &size
    ) == noErr && size >= UInt32(MemoryLayout<AudioStreamID>.size)
  }

  private static func deviceUID(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(kAudioDevicePropertyDeviceUID, deviceID: deviceID)
  }

  private static func deviceName(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(kAudioObjectPropertyName, deviceID: deviceID)
  }

  private static func stringProperty(
    _ selector: AudioObjectPropertySelector,
    deviceID: AudioDeviceID
  ) -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
      AudioObjectGetPropertyData(
        deviceID,
        &address,
        0,
        nil,
        &size,
        pointer
      )
    }
    guard status == noErr else { return nil }
    return value as String
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
