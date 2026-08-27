import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

enum DesktopMicrophoneCaptureError: Error {
  case permissionDenied
  case noInputDevice
  case selectedInputUnavailable
  case selectedInputInactive
  case selectedInputFailed(OSStatus)
  case invalidFormat
  case engineStart(Error)
}

enum MicrophoneCaptureDiagnostic: String, Equatable {
  case permissionDenied = "permission_denied"
  case selectedUIDUnavailable = "selected_uid_unavailable"
  case selectedDeviceInactive = "selected_device_inactive"
  case audioUnitSelectionFailed = "audio_unit_selection_failed"
  case initialEngineStartFailed = "initial_engine_start_failed"
  case recoveryRestartFailed = "recovery_restart_failed"
  case unsupportedFormat = "unsupported_format"
}

extension DesktopMicrophoneCaptureError {
  var diagnostic: MicrophoneCaptureDiagnostic {
    switch self {
    case .permissionDenied:
      return .permissionDenied
    case .noInputDevice, .selectedInputUnavailable:
      return .selectedUIDUnavailable
    case .selectedInputInactive:
      return .selectedDeviceInactive
    case .selectedInputFailed:
      return .audioUnitSelectionFailed
    case .invalidFormat:
      return .unsupportedFormat
    case .engineStart:
      return .initialEngineStartFailed
    }
  }
}

enum MicrophoneSelectedDeviceState: Equatable {
  case available(AudioDeviceID)
  case uidUnavailable
  case inactive
  case queryFailed
}

protocol MicrophoneCaptureScheduling: AnyObject {
  var now: TimeInterval { get }
  func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () -> Void)
}

final class DispatchMicrophoneCaptureScheduler: MicrophoneCaptureScheduling {
  private let queue: DispatchQueue

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

  func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () -> Void) {
    queue.asyncAfter(deadline: .now() + delay, execute: action)
  }
}

protocol MicrophoneCaptureEngine: AnyObject {
  var isRunning: Bool { get }
  var configurationChangeObject: AnyObject { get }
  func activeInputFormat() -> AVAudioFormat
  func selectInputDevice(_ deviceID: AudioDeviceID) throws
  func installTap(
    format: AVAudioFormat,
    _ handler: @escaping (AVAudioPCMBuffer) -> Void
  )
  func removeTap()
  func prepare()
  func start() throws
  func pause()
  func stop()
}

private struct MicrophoneAudioUnitSelectionError: Error {
  let status: OSStatus
}

final class AVAudioEngineMicrophoneCaptureEngine: MicrophoneCaptureEngine {
  private let engine = AVAudioEngine()

  var isRunning: Bool { engine.isRunning }
  var configurationChangeObject: AnyObject { engine }

  func activeInputFormat() -> AVAudioFormat {
    engine.inputNode.inputFormat(forBus: 0)
  }

  func selectInputDevice(_ deviceID: AudioDeviceID) throws {
    guard let audioUnit = engine.inputNode.audioUnit else {
      throw MicrophoneAudioUnitSelectionError(status: kAudio_ParamError)
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
      throw MicrophoneAudioUnitSelectionError(status: status)
    }
  }

  func installTap(
    format: AVAudioFormat,
    _ handler: @escaping (AVAudioPCMBuffer) -> Void
  ) {
    let input = engine.inputNode
    input.installTap(
      onBus: 0,
      bufferSize: 1024,
      format: format
    ) { buffer, _ in
      handler(buffer)
    }
  }

  func removeTap() {
    engine.inputNode.removeTap(onBus: 0)
  }

  func prepare() { engine.prepare() }
  func start() throws { try engine.start() }
  func pause() { engine.pause() }
  func stop() { engine.stop() }
}

struct CoreAudioInputDevice {
  let audioDeviceID: AudioDeviceID
  let uniqueID: String
  let name: String
}

enum MicrophonePCMBufferMeterResult {
  case noFrames
  case samples(frames: UInt64, normalizedRMS: Double, normalizedPeak: Double)
  case unsupportedFormat
}

enum MicrophoneMeterStatus {
  case noFrames
  case samples
  case unsupportedFormat
}

enum MicrophonePCMBufferMeter {
  static func measure(_ buffer: AVAudioPCMBuffer) -> MicrophonePCMBufferMeterResult {
    let frameCount = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    guard frameCount > 0, channelCount > 0 else { return .noFrames }
    guard
      buffer.format.commonFormat == .pcmFormatFloat32
        || buffer.format.commonFormat == .pcmFormatInt16
        || buffer.format.commonFormat == .pcmFormatInt32
    else {
      return .unsupportedFormat
    }

    let audioBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let interleaved = buffer.format.isInterleaved
    let stride = Int(buffer.stride)
    guard stride > 0, audioBuffers.count >= (interleaved ? 1 : channelCount) else {
      return .unsupportedFormat
    }

    var maximumRMS = 0.0
    var maximumPeak = 0.0
    for channel in 0..<channelCount {
      let audioBuffer = audioBuffers[interleaved ? 0 : channel]
      guard let data = audioBuffer.mData else { return .unsupportedFormat }
      var sumOfSquares = 0.0
      var channelPeak = 0.0
      for frame in 0..<frameCount {
        let offset = frame * stride + (interleaved ? channel : 0)
        let sample: Double
        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
          sample = Double(data.assumingMemoryBound(to: Float.self)[offset])
        case .pcmFormatInt16:
          sample = Double(data.assumingMemoryBound(to: Int16.self)[offset]) / 32_768.0
        case .pcmFormatInt32:
          sample = Double(data.assumingMemoryBound(to: Int32.self)[offset]) / 2_147_483_648.0
        default:
          return .unsupportedFormat
        }
        let normalized = min(1, max(-1, sample))
        sumOfSquares += normalized * normalized
        channelPeak = max(channelPeak, abs(normalized))
      }
      maximumRMS = max(maximumRMS, sqrt(sumOfSquares / Double(frameCount)))
      maximumPeak = max(maximumPeak, channelPeak)
    }
    return .samples(
      frames: UInt64(frameCount),
      normalizedRMS: maximumRMS,
      normalizedPeak: maximumPeak
    )
  }
}

struct MicrophoneMeterAccumulator {
  private let retentionNanoseconds: UInt64
  private var windowStartedAt: UInt64?
  private var maximumRMS = 0.0
  private var maximumPeak = 0.0

  init(retentionNanoseconds: UInt64 = 250_000_000) {
    self.retentionNanoseconds = retentionNanoseconds
  }

  mutating func record(
    normalizedRMS: Double,
    normalizedPeak: Double,
    at timestamp: UInt64
  ) {
    if windowStartedAt == nil {
      windowStartedAt = timestamp
    }
    maximumRMS = max(maximumRMS, min(1, max(0, normalizedRMS)))
    maximumPeak = max(maximumPeak, min(1, max(0, normalizedPeak)))
  }

  mutating func consume(at timestamp: UInt64) -> (
    normalizedRMS: Double,
    normalizedPeak: Double
  ) {
    guard let windowStartedAt,
      timestamp >= windowStartedAt,
      timestamp - windowStartedAt <= retentionNanoseconds
    else {
      reset()
      return (0, 0)
    }
    let result = (maximumRMS, maximumPeak)
    reset()
    return result
  }

  private mutating func reset() {
    windowStartedAt = nil
    maximumRMS = 0
    maximumPeak = 0
  }
}

final class MicrophoneCapture: @unchecked Sendable {
  struct MeterSnapshot {
    let observedFrames: UInt64
    let normalizedRMS: Double
    let normalizedPeak: Double
    let status: MicrophoneMeterStatus
  }

  private static let recoveryDelays: [TimeInterval] = [0, 0.25, 0.5, 1, 2]
  private static let recoveryDeadline: TimeInterval = 4

  private let engine: MicrophoneCaptureEngine
  private let scheduler: MicrophoneCaptureScheduling
  private let recoveryQueue: DispatchQueue
  private let recoveryQueueKey = DispatchSpecificKey<UInt8>()
  private let notificationCenter: NotificationCenter
  private let permissionGranted: () -> Bool
  private let selectedDeviceQuery: (String) -> MicrophoneSelectedDeviceState
  private(set) var observedFrames: UInt64 = 0
  private(set) var deliveredFrames: UInt64 = 0
  private(set) var sampleRate: Double = 0
  private(set) var channelCount: UInt32 = 0
  private(set) var normalizedPeak: Double = 0
  private(set) var format: AVAudioFormat?
  private var bufferHandler: ((AVAudioPCMBuffer) -> Void)?
  private var healthHandler: ((MicrophoneCaptureDiagnostic) -> Void)?
  private var installedTap = false
  private var configurationObserver: NSObjectProtocol?
  private let selectedDeviceUniqueID: String?
  private let meterLock = NSLock()
  private let healthHandlerLock = NSLock()
  private let recoveryNotificationLock = NSLock()
  private var meterAccumulator = MicrophoneMeterAccumulator()
  private var meterStatus = MicrophoneMeterStatus.noFrames
  private var recoveryStartedAt: TimeInterval?
  private var recovering = false
  private var recoveryNotificationActive = false
  private var captureActive = false
  private var tornDown = false

  init(
    selectedDeviceUniqueID: String? = nil,
    bufferHandler: ((AVAudioPCMBuffer) -> Void)? = nil,
    healthHandler: ((MicrophoneCaptureDiagnostic) -> Void)? = nil
  ) {
    let queue = DispatchQueue(label: "voice2text.microphone-capture.recovery")
    self.engine = AVAudioEngineMicrophoneCaptureEngine()
    self.scheduler = DispatchMicrophoneCaptureScheduler(queue: queue)
    self.recoveryQueue = queue
    self.notificationCenter = .default
    self.permissionGranted = {
      AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }
    self.selectedDeviceQuery = Self.selectedDeviceState(uniqueID:)
    self.selectedDeviceUniqueID = selectedDeviceUniqueID
    self.bufferHandler = bufferHandler
    self.healthHandler = healthHandler
    queue.setSpecific(key: recoveryQueueKey, value: 1)
  }

  init(
    selectedDeviceUniqueID: String? = nil,
    engine: MicrophoneCaptureEngine,
    scheduler: MicrophoneCaptureScheduling,
    recoveryQueue: DispatchQueue,
    notificationCenter: NotificationCenter = NotificationCenter(),
    permissionGranted: @escaping () -> Bool = { true },
    selectedDeviceQuery: @escaping (String) -> MicrophoneSelectedDeviceState = { _ in
      .available(AudioDeviceID(1))
    },
    bufferHandler: ((AVAudioPCMBuffer) -> Void)? = nil,
    healthHandler: ((MicrophoneCaptureDiagnostic) -> Void)? = nil
  ) {
    self.engine = engine
    self.scheduler = scheduler
    self.recoveryQueue = recoveryQueue
    self.notificationCenter = notificationCenter
    self.permissionGranted = permissionGranted
    self.selectedDeviceQuery = selectedDeviceQuery
    self.selectedDeviceUniqueID = selectedDeviceUniqueID
    self.bufferHandler = bufferHandler
    self.healthHandler = healthHandler
    recoveryQueue.setSpecific(key: recoveryQueueKey, value: 1)
  }

  func setBufferHandler(_ handler: ((AVAudioPCMBuffer) -> Void)?) {
    bufferHandler = handler
  }

  func setHealthHandler(_ handler: ((MicrophoneCaptureDiagnostic) -> Void)?) {
    healthHandlerLock.lock()
    healthHandler = handler
    healthHandlerLock.unlock()
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
    if DispatchQueue.getSpecific(key: recoveryQueueKey) == 1 {
      try startLocked()
    } else {
      try recoveryQueue.sync {
        try startLocked()
      }
    }
  }

  private func startLocked() throws {
    if engine.isRunning {
      captureActive = true
      return
    }
    guard permissionGranted() else {
      throw DesktopMicrophoneCaptureError.permissionDenied
    }
    try selectInputDeviceIfNeeded()
    let format = engine.activeInputFormat()
    guard Self.isSupported(format) else {
      throw DesktopMicrophoneCaptureError.invalidFormat
    }
    apply(format)
    installTapIfNeeded(format: format)
    installConfigurationObserverIfNeeded()
    captureActive = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      captureActive = false
      throw DesktopMicrophoneCaptureError.engineStart(error)
    }
  }

  private func installTapIfNeeded(format: AVAudioFormat) {
    guard !installedTap else { return }
    engine.installTap(format: format) { [weak self] buffer in
      self?.consume(buffer)
    }
    installedTap = true
  }

  private func consume(_ buffer: AVAudioPCMBuffer) {
    meterLock.lock()
    switch MicrophonePCMBufferMeter.measure(buffer) {
    case .noFrames:
      meterStatus = .noFrames
    case let .samples(frames, normalizedRMS, normalizedPeak):
      observedFrames &+= frames
      self.normalizedPeak = normalizedPeak
      meterStatus = .samples
      meterAccumulator.record(
        normalizedRMS: normalizedRMS,
        normalizedPeak: normalizedPeak,
        at: DispatchTime.now().uptimeNanoseconds
      )
    case .unsupportedFormat:
      meterStatus = .unsupportedFormat
    }
    meterLock.unlock()
    guard let handler = bufferHandler,
      let copy = CaptureChunkJournal.clone(buffer)
    else {
      return
    }
    deliveredFrames &+= UInt64(copy.frameLength)
    handler(copy)
  }

  private func installConfigurationObserverIfNeeded() {
    guard configurationObserver == nil else { return }
    configurationObserver = notificationCenter.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine.configurationChangeObject,
      queue: nil
    ) { [weak self] _ in
      self?.configurationChanged()
    }
  }

  func configurationChanged() {
    recoveryNotificationLock.lock()
    guard !recoveryNotificationActive else {
      recoveryNotificationLock.unlock()
      return
    }
    recoveryNotificationActive = true
    recoveryNotificationLock.unlock()
    recoveryQueue.async { [weak self] in
      self?.beginRecoveryIfNeeded()
    }
  }

  private func beginRecoveryIfNeeded() {
    guard !tornDown, captureActive, !recovering else {
      setRecoveryNotificationActive(false)
      return
    }
    recovering = true
    recoveryStartedAt = scheduler.now
    runRecoveryAttempt(0, lastDiagnostic: .recoveryRestartFailed)
  }

  private func runRecoveryAttempt(
    _ index: Int,
    lastDiagnostic: MicrophoneCaptureDiagnostic
  ) {
    guard !tornDown, recovering, let recoveryStartedAt else { return }
    guard index < Self.recoveryDelays.count,
      scheduler.now - recoveryStartedAt <= Self.recoveryDeadline
    else {
      failRecovery(lastDiagnostic)
      return
    }

    let delay = Self.recoveryDelays[index]
    scheduler.schedule(after: delay) { [weak self] in
      guard let self else { return }
      self.recoveryQueue.async {
        self.performRecoveryAttempt(
          index,
          startedAt: recoveryStartedAt,
          previousDiagnostic: lastDiagnostic
        )
      }
    }
  }

  private func performRecoveryAttempt(
    _ index: Int,
    startedAt: TimeInterval,
    previousDiagnostic: MicrophoneCaptureDiagnostic
  ) {
    guard !tornDown, recovering, recoveryStartedAt == startedAt else { return }
    guard scheduler.now - startedAt <= Self.recoveryDeadline else {
      failRecovery(previousDiagnostic)
      return
    }

    do {
      try selectInputDeviceIfNeeded()
    } catch DesktopMicrophoneCaptureError.selectedInputUnavailable {
      failRecovery(.selectedUIDUnavailable)
      return
    } catch DesktopMicrophoneCaptureError.selectedInputInactive {
      failRecovery(.selectedDeviceInactive)
      return
    } catch {
      scheduleNextRecoveryAttempt(index, diagnostic: .audioUnitSelectionFailed)
      return
    }

    if engine.isRunning {
      engine.stop()
    }
    if installedTap {
      engine.removeTap()
      installedTap = false
    }
    let nextFormat = engine.activeInputFormat()
    guard Self.isSupported(nextFormat) else {
      scheduleNextRecoveryAttempt(index, diagnostic: .unsupportedFormat)
      return
    }
    apply(nextFormat)
    installTapIfNeeded(format: nextFormat)
    engine.prepare()
    do {
      try engine.start()
      recovering = false
      recoveryStartedAt = nil
      setRecoveryNotificationActive(false)
    } catch {
      scheduleNextRecoveryAttempt(index, diagnostic: .recoveryRestartFailed)
    }
  }

  private func scheduleNextRecoveryAttempt(
    _ completedIndex: Int,
    diagnostic: MicrophoneCaptureDiagnostic
  ) {
    let nextIndex = completedIndex + 1
    guard nextIndex < Self.recoveryDelays.count else {
      failRecovery(diagnostic)
      return
    }
    runRecoveryAttempt(nextIndex, lastDiagnostic: diagnostic)
  }

  private func failRecovery(_ diagnostic: MicrophoneCaptureDiagnostic) {
    guard recovering, !tornDown else { return }
    recovering = false
    recoveryStartedAt = nil
    setRecoveryNotificationActive(false)
    healthHandlerLock.lock()
    let handler = healthHandler
    healthHandlerLock.unlock()
    teardownLocked()
    handler?(diagnostic)
  }

  private func apply(_ format: AVAudioFormat) {
    sampleRate = format.sampleRate
    channelCount = format.channelCount
    self.format = format
  }

  private static func isSupported(_ format: AVAudioFormat) -> Bool {
    format.sampleRate > 0 && format.channelCount > 0
  }

  private func setRecoveryNotificationActive(_ active: Bool) {
    recoveryNotificationLock.lock()
    recoveryNotificationActive = active
    recoveryNotificationLock.unlock()
  }

  func meterSnapshot() -> MeterSnapshot {
    meterLock.lock()
    defer { meterLock.unlock() }
    let retained = meterAccumulator.consume(at: DispatchTime.now().uptimeNanoseconds)
    return MeterSnapshot(
      observedFrames: observedFrames,
      normalizedRMS: retained.normalizedRMS,
      normalizedPeak: retained.normalizedPeak,
      status: meterStatus
    )
  }

  private func selectInputDeviceIfNeeded() throws {
    guard let selectedDeviceUniqueID else { return }
    let deviceID: AudioDeviceID
    switch selectedDeviceQuery(selectedDeviceUniqueID) {
    case let .available(availableDeviceID):
      deviceID = availableDeviceID
    case .uidUnavailable:
      throw DesktopMicrophoneCaptureError.selectedInputUnavailable
    case .inactive:
      throw DesktopMicrophoneCaptureError.selectedInputInactive
    case .queryFailed:
      throw DesktopMicrophoneCaptureError.selectedInputFailed(
        kAudioHardwareUnspecifiedError
      )
    }
    do {
      try engine.selectInputDevice(deviceID)
    } catch let error as MicrophoneAudioUnitSelectionError {
      throw DesktopMicrophoneCaptureError.selectedInputFailed(error.status)
    } catch {
      throw DesktopMicrophoneCaptureError.selectedInputFailed(kAudio_ParamError)
    }
  }

  private static func selectedDeviceState(uniqueID: String) -> MicrophoneSelectedDeviceState {
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
    guard status == noErr else { return .queryFailed }
    guard deviceID != kAudioObjectUnknown else { return .uidUnavailable }

    address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceIsAlive,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var alive: UInt32 = 0
    resultSize = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(
      deviceID,
      &address,
      0,
      nil,
      &resultSize,
      &alive
    ) == noErr else {
      return .queryFailed
    }
    return alive == 0 ? .inactive : .available(deviceID)
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

  func pause() {
    let action = {
      self.captureActive = false
      self.recovering = false
      self.recoveryStartedAt = nil
      self.setRecoveryNotificationActive(false)
      if self.engine.isRunning {
        self.engine.pause()
      }
    }
    if DispatchQueue.getSpecific(key: recoveryQueueKey) == 1 {
      action()
    } else {
      recoveryQueue.sync(execute: action)
    }
  }

  func teardown() {
    if DispatchQueue.getSpecific(key: recoveryQueueKey) == 1 {
      teardownLocked()
    } else {
      recoveryQueue.sync {
        teardownLocked()
      }
    }
  }

  private func teardownLocked() {
    guard !tornDown else { return }
    tornDown = true
    recovering = false
    captureActive = false
    recoveryStartedAt = nil
    setRecoveryNotificationActive(false)
    if let configurationObserver {
      notificationCenter.removeObserver(configurationObserver)
      self.configurationObserver = nil
    }
    if engine.isRunning {
      engine.stop()
    }
    if installedTap {
      engine.removeTap()
      installedTap = false
    }
  }
}
