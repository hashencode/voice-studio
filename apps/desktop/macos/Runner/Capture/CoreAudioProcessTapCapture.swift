import AVFoundation
import CoreAudio
import Foundation

enum DesktopSystemAudioCaptureError: Error {
  case unsupportedMacos
  case processObjectUnavailable
  case createTap(OSStatus)
  case readTapUID(OSStatus)
  case createAggregate(OSStatus)
  case attachTap(OSStatus)
  case aggregateNotReady(String)
  case start(OSStatus)
}

@available(macOS 14.2, *)
final class CoreAudioProcessTapCapture {
  private(set) var tapID = AudioObjectID(kAudioObjectUnknown)
  private(set) var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
  private(set) var sampleRate: Double = 0
  private(set) var channelCount: UInt32 = 0
  private(set) var observedFrames: UInt64 = 0
  private(set) var deliveredFrames: UInt64 = 0
  private(set) var normalizedPeak: Double = 0
  private(set) var startAttempts = 0
  private(set) var format: AVAudioFormat?
  private var bytesPerFrame: UInt32 = 0
  private var bufferHandler: ((AVAudioPCMBuffer) -> Void)?
  private var ioProcID: AudioDeviceIOProcID?
  private var started = false

  init(bufferHandler: ((AVAudioPCMBuffer) -> Void)? = nil) {
    self.bufferHandler = bufferHandler
  }

  deinit {
    teardown()
  }

  func setBufferHandler(_ handler: ((AVAudioPCMBuffer) -> Void)?) {
    bufferHandler = handler
  }

  func prepare() throws {
    guard tapID == kAudioObjectUnknown else { return }

    let processObjectID = try currentProcessAudioObjectID()
    let description = CATapDescription()
    description.name = "Voice2Text system audio"
    description.processes = [processObjectID]
    description.isPrivate = true
    description.isExclusive = true
    description.isMixdown = true
    description.isMono = false
    description.muteBehavior = .unmuted

    var nextTapID = AudioObjectID(kAudioObjectUnknown)
    let createTapStatus = AudioHardwareCreateProcessTap(
      description,
      &nextTapID
    )
    guard createTapStatus == noErr else {
      throw DesktopSystemAudioCaptureError.createTap(createTapStatus)
    }
    tapID = nextTapID

    do {
      let tapUID = try readTapUID()
      let aggregateDescription: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Voice2Text private capture",
        kAudioAggregateDeviceUIDKey: "com.voice2text.capture.\(UUID().uuidString)",
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: true,
      ]
      var nextAggregateID = AudioObjectID(kAudioObjectUnknown)
      let createAggregateStatus = AudioHardwareCreateAggregateDevice(
        aggregateDescription as CFDictionary,
        &nextAggregateID
      )
      guard createAggregateStatus == noErr else {
        throw DesktopSystemAudioCaptureError.createAggregate(
          createAggregateStatus
        )
      }
      aggregateDeviceID = nextAggregateID
      try attachTap(uid: tapUID)
      try waitForAggregateReady(tapUID: tapUID)
      try readTapFormat()
    } catch {
      teardown()
      throw error
    }
  }

  func start() throws {
    if started { return }
    try prepare()
    if ioProcID == nil {
      var nextIOProcID: AudioDeviceIOProcID?
      let status = AudioDeviceCreateIOProcIDWithBlock(
        &nextIOProcID,
        aggregateDeviceID,
        nil
      ) { [weak self] _, inputData, _, _, _ in
        guard let self else { return }
        let byteCount = inputData.pointee.mBuffers.mDataByteSize
        self.observedFrames &+= UInt64(
          byteCount / max(1, self.bytesPerFrame)
        )
        guard let handler = self.bufferHandler,
          let copied = self.copyInputBuffer(inputData)
        else {
          return
        }
        self.normalizedPeak = Self.peak(copied)
        self.deliveredFrames &+= UInt64(copied.frameLength)
        handler(copied)
      }
      guard status == noErr, nextIOProcID != nil else {
        throw DesktopSystemAudioCaptureError.start(status)
      }
      ioProcID = nextIOProcID
    }
    var status = noErr
    for attempt in 1...3 {
      startAttempts = attempt
      status = AudioDeviceStart(aggregateDeviceID, ioProcID)
      if status == noErr {
        started = true
        return
      }
      if attempt < 3 {
        Thread.sleep(forTimeInterval: 0.1 * Double(attempt))
      }
    }
    throw DesktopSystemAudioCaptureError.start(status)
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
    guard started else { return }
    AudioDeviceStop(aggregateDeviceID, ioProcID)
    started = false
  }

  func teardown() {
    pause()
    if let ioProcID, aggregateDeviceID != kAudioObjectUnknown {
      AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
    }
    ioProcID = nil
    if aggregateDeviceID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
      aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
  }

  private func currentProcessAudioObjectID() throws -> AudioObjectID {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var pid = getpid()
    var processObjectID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = withUnsafePointer(to: &pid) { qualifier in
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        UInt32(MemoryLayout<pid_t>.size),
        qualifier,
        &size,
        &processObjectID
      )
    }
    guard status == noErr, processObjectID != kAudioObjectUnknown else {
      throw DesktopSystemAudioCaptureError.processObjectUnavailable
    }
    return processObjectID
  }

  private func readTapUID() throws -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyUID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<CFString>.stride)
    var uid: CFString = "" as CFString
    let status = withUnsafeMutablePointer(to: &uid) { pointer in
      AudioObjectGetPropertyData(
        tapID,
        &address,
        0,
        nil,
        &size,
        pointer
      )
    }
    guard status == noErr else {
      throw DesktopSystemAudioCaptureError.readTapUID(status)
    }
    return uid as String
  }

  private func attachTap(uid: String) throws {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioAggregateDevicePropertyTapList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var list: CFArray? = [uid as CFString] as CFArray
    let size = UInt32(MemoryLayout<CFString>.stride)
    let status = withUnsafeMutablePointer(to: &list) { pointer in
      AudioObjectSetPropertyData(
        aggregateDeviceID,
        &address,
        0,
        nil,
        size,
        pointer
      )
    }
    guard status == noErr else {
      throw DesktopSystemAudioCaptureError.attachTap(status)
    }
  }

  private func waitForAggregateReady(tapUID: String) throws {
    let deadline = Date().addingTimeInterval(2)
    var lastState = "unobserved"
    repeat {
      let attached = aggregateTapUIDs().contains(tapUID)
      let alive = aggregateIsAlive()
      let inputStreams = aggregateInputStreamCount()
      lastState =
        "tapAttached=\(attached),alive=\(alive),inputStreams=\(inputStreams)"
      if attached, alive, inputStreams > 0 {
        return
      }
      Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline
    throw DesktopSystemAudioCaptureError.aggregateNotReady(lastState)
  }

  private func aggregateTapUIDs() -> [String] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioAggregateDevicePropertyTapList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard
      AudioObjectGetPropertyDataSize(
        aggregateDeviceID,
        &address,
        0,
        nil,
        &size
      ) == noErr
    else {
      return []
    }
    var value: CFArray?
    guard
      withUnsafeMutablePointer(to: &value, {
        AudioObjectGetPropertyData(
          aggregateDeviceID,
          &address,
          0,
          nil,
          &size,
          $0
        )
      }) == noErr
    else {
      return []
    }
    return (value as? [String]) ?? []
  }

  private func aggregateIsAlive() -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceIsAlive,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(
      aggregateDeviceID,
      &address,
      0,
      nil,
      &size,
      &value
    ) == noErr && value != 0
  }

  private func aggregateInputStreamCount() -> Int {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard
      AudioObjectGetPropertyDataSize(
        aggregateDeviceID,
        &address,
        0,
        nil,
        &size
      ) == noErr
    else {
      return 0
    }
    return Int(size) / MemoryLayout<AudioStreamID>.stride
  }

  private func readTapFormat() throws {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(
      tapID,
      &address,
      0,
      nil,
      &size,
      &format
    )
    guard status == noErr else {
      throw DesktopSystemAudioCaptureError.readTapUID(status)
    }
    sampleRate = format.mSampleRate
    channelCount = format.mChannelsPerFrame
    bytesPerFrame = format.mBytesPerFrame
    self.format = AVAudioFormat(streamDescription: &format)
  }

  private func copyInputBuffer(
    _ inputData: UnsafePointer<AudioBufferList>
  ) -> AVAudioPCMBuffer? {
    guard let format, bytesPerFrame > 0 else { return nil }
    let sourceBuffers = UnsafeMutableAudioBufferListPointer(
      UnsafeMutablePointer(mutating: inputData)
    )
    guard
      let first = sourceBuffers.first,
      first.mDataByteSize > 0
    else {
      return nil
    }
    let frameCount = AVAudioFrameCount(first.mDataByteSize / bytesPerFrame)
    guard
      frameCount > 0,
      let copy = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: frameCount
      )
    else {
      return nil
    }
    copy.frameLength = frameCount
    let destinationBuffers = UnsafeMutableAudioBufferListPointer(
      copy.mutableAudioBufferList
    )
    guard sourceBuffers.count == destinationBuffers.count else {
      return nil
    }
    for index in 0..<sourceBuffers.count {
      let source = sourceBuffers[index]
      let byteCount = Int(source.mDataByteSize)
      guard
        let sourceData = source.mData,
        let destinationData = destinationBuffers[index].mData
      else {
        return nil
      }
      memcpy(destinationData, sourceData, byteCount)
      destinationBuffers[index].mDataByteSize = source.mDataByteSize
    }
    return copy
  }
}
