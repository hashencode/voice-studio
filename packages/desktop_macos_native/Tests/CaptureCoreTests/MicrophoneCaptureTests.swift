import AVFoundation
import XCTest
@testable import CaptureCore

final class MicrophoneCaptureTests: XCTestCase {
  func testCoreAudioInputsRemainVisibleToCapturePreflight() {
    let devices = MicrophoneCapture.captureDevices(
      from: [
        CoreAudioInputDevice(
          audioDeviceID: 1,
          uniqueID: "built-in",
          name: "Mac microphone"
        ),
        CoreAudioInputDevice(
          audioDeviceID: 2,
          uniqueID: "external",
          name: "External microphone"
        ),
      ],
      defaultAudioDeviceID: 2
    )

    XCTAssertEqual(devices.map(\.id), ["built-in", "external"])
    XCTAssertEqual(devices.map(\.name), ["Mac microphone", "External microphone"])
    XCTAssertEqual(devices.map(\.isDefault), [false, true])
  }

  func testEquivalentPCMFormatsProduceMatchingRMSAndPeak() throws {
    let samples: [Double] = [-0.5, 0.25, 0.5, -0.25]
    let floatResult = try XCTUnwrap(meterResult(format: .pcmFormatFloat32, samples: samples))
    let int16Result = try XCTUnwrap(meterResult(format: .pcmFormatInt16, samples: samples))
    let int32Result = try XCTUnwrap(meterResult(format: .pcmFormatInt32, samples: samples))

    XCTAssertEqual(floatResult.normalizedPeak, 0.5, accuracy: 0.0001)
    XCTAssertEqual(floatResult.normalizedRMS, sqrt(0.15625), accuracy: 0.0001)
    XCTAssertEqual(int16Result.normalizedPeak, floatResult.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(int16Result.normalizedRMS, floatResult.normalizedRMS, accuracy: 0.0001)
    XCTAssertEqual(int32Result.normalizedPeak, floatResult.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(int32Result.normalizedRMS, floatResult.normalizedRMS, accuracy: 0.0001)
  }

  func testPlanarAndInterleavedLayoutsHonorStrideAndMergeChannels() throws {
    let channels = [
      [0.1, -0.1, 0.1, -0.1],
      [0.75, -0.25, 0.75, -0.25],
    ]
    let planar = try XCTUnwrap(
      meterResult(format: .pcmFormatFloat32, channels: channels, interleaved: false)
    )
    let interleaved = try XCTUnwrap(
      meterResult(format: .pcmFormatFloat32, channels: channels, interleaved: true)
    )

    XCTAssertEqual(planar.normalizedPeak, 0.75, accuracy: 0.0001)
    XCTAssertEqual(planar.normalizedRMS, sqrt(0.3125), accuracy: 0.0001)
    XCTAssertEqual(interleaved.normalizedPeak, planar.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(interleaved.normalizedRMS, planar.normalizedRMS, accuracy: 0.0001)
  }

  func testMeterDistinguishesNoFramesZeroEnergyAndUnsupportedFormat() throws {
    let empty = try makeBuffer(format: .pcmFormatFloat32, channels: [[]], interleaved: false)
    guard case .noFrames = MicrophonePCMBufferMeter.measure(empty) else {
      return XCTFail("zero frame buffers must remain distinguishable")
    }

    let silent = try makeBuffer(
      format: .pcmFormatFloat32,
      channels: [[0, 0, 0]],
      interleaved: false
    )
    guard case let .samples(frames, rms, peak) = MicrophonePCMBufferMeter.measure(silent) else {
      return XCTFail("silent samples must remain valid samples")
    }
    XCTAssertEqual(frames, 3)
    XCTAssertEqual(rms, 0)
    XCTAssertEqual(peak, 0)

    let unsupportedFormat = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: .pcmFormatFloat64,
        sampleRate: 48_000,
        channels: 1,
        interleaved: false
      )
    )
    let unsupported = try XCTUnwrap(
      AVAudioPCMBuffer(pcmFormat: unsupportedFormat, frameCapacity: 1)
    )
    unsupported.frameLength = 1
    guard case .unsupportedFormat = MicrophonePCMBufferMeter.measure(unsupported) else {
      return XCTFail("unknown PCM formats must not look like silence")
    }
  }

  func testIntegerMinimumValuesNormalizeWithoutOverflow() throws {
    let int16 = try XCTUnwrap(
      meterResult(format: .pcmFormatInt16, integerMinimum: true)
    )
    let int32 = try XCTUnwrap(
      meterResult(format: .pcmFormatInt32, integerMinimum: true)
    )

    XCTAssertEqual(int16.normalizedPeak, 1, accuracy: 0.0001)
    XCTAssertEqual(int16.normalizedRMS, 1, accuracy: 0.0001)
    XCTAssertEqual(int32.normalizedPeak, 1, accuracy: 0.0001)
    XCTAssertEqual(int32.normalizedRMS, 1, accuracy: 0.0001)
  }

  func testMeterWindowIsConsumedOnceAndExpiresAfterRetentionLimit() {
    var accumulator = MicrophoneMeterAccumulator(retentionNanoseconds: 250_000_000)
    accumulator.record(normalizedRMS: 0.4, normalizedPeak: 0.8, at: 1_000_000_000)
    accumulator.record(normalizedRMS: 0.1, normalizedPeak: 0.2, at: 1_021_000_000)

    let first = accumulator.consume(at: 1_050_000_000)
    XCTAssertEqual(first.normalizedRMS, 0.4)
    XCTAssertEqual(first.normalizedPeak, 0.8)
    let second = accumulator.consume(at: 1_050_000_001)
    XCTAssertEqual(second.normalizedRMS, 0)
    XCTAssertEqual(second.normalizedPeak, 0)

    accumulator.record(normalizedRMS: 0.5, normalizedPeak: 0.7, at: 2_000_000_000)
    let expired = accumulator.consume(at: 2_250_000_001)
    XCTAssertEqual(expired.normalizedRMS, 0)
    XCTAssertEqual(expired.normalizedPeak, 0)
  }

  func testValidSelectedUIDStartsOnceAndPublishesFramesWithoutConfigurationChange() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    var deliveredFrames: AVAudioFrameCount = 0
    harness.capture.setBufferHandler { deliveredFrames += $0.frameLength }

    try harness.capture.start()
    let buffer = try makeBuffer(
      format: .pcmFormatFloat32,
      channels: [[0.25, -0.25]],
      interleaved: false
    )
    harness.engine.emit(buffer)

    XCTAssertEqual(harness.deviceQueryCount, 1)
    XCTAssertEqual(harness.engine.selectedDeviceIDs, [42])
    XCTAssertEqual(harness.engine.startCount, 1)
    XCTAssertEqual(harness.engine.activeTapCount, 1)
    XCTAssertEqual(deliveredFrames, 2)
    XCTAssertEqual(harness.capture.meterSnapshot().observedFrames, 2)
  }

  func testConfigurationChangeRestartsOnceWithRenegotiatedFormat() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    harness.engine.onStart = { [weak harness] in
      guard harness?.engine.startCount == 1 else { return }
      harness?.postConfigurationChangeWithoutFlushing()
    }
    try harness.capture.start()
    harness.flushRecoveryQueue()
    harness.engine.format = Self.format(sampleRate: 16_000, channels: 2)

    harness.runNextScheduledAction()

    XCTAssertEqual(harness.engine.startCount, 2)
    XCTAssertEqual(harness.engine.maximumActiveTapCount, 1)
    XCTAssertEqual(harness.engine.activeTapCount, 1)
    XCTAssertEqual(harness.capture.sampleRate, 16_000)
    XCTAssertEqual(harness.capture.channelCount, 2)
    XCTAssertEqual(harness.diagnostics, [])
  }

  func testRecoveryCanSucceedOnFifthAttemptAtThreePointSevenFiveSeconds() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()
    harness.engine.startResults = [.failure(FakeEngineError.failed), .failure(.failed),
      .failure(.failed), .failure(.failed), .success(())]

    harness.postConfigurationChange()
    harness.runAllScheduledActions()

    XCTAssertEqual(harness.scheduler.now, 3.75, accuracy: 0.0001)
    XCTAssertEqual(harness.engine.startCount, 6)
    XCTAssertEqual(harness.deviceQueryCount, 6)
    XCTAssertEqual(harness.engine.activeFormatCount, 6)
    XCTAssertEqual(harness.engine.maximumActiveTapCount, 1)
    XCTAssertEqual(harness.diagnostics, [])
  }

  func testInvalidFormatExhaustsFiveAttemptsAndPublishesOneBoundedFailure() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()
    harness.engine.format = AVAudioFormat()

    harness.postConfigurationChange()
    harness.runAllScheduledActions()

    XCTAssertEqual(harness.scheduler.executedDelays, [0, 0.25, 0.5, 1, 2])
    XCTAssertEqual(harness.scheduler.now, 3.75, accuracy: 0.0001)
    XCTAssertEqual(harness.deviceQueryCount, 6)
    XCTAssertEqual(harness.diagnostics, [MicrophoneCaptureDiagnostic.unsupportedFormat.rawValue])
    XCTAssertEqual(harness.engine.stopCount, 1)
    XCTAssertEqual(harness.scheduler.pendingCount, 0)
  }

  func testFourSecondDeadlinePreventsAQueuedLateAttempt() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()
    harness.postConfigurationChange()
    harness.scheduler.now = 4.001

    harness.runNextScheduledAction()

    XCTAssertEqual(harness.engine.startCount, 1)
    XCTAssertEqual(harness.deviceQueryCount, 1)
    XCTAssertEqual(
      harness.diagnostics,
      [MicrophoneCaptureDiagnostic.recoveryRestartFailed.rawValue]
    )
    XCTAssertEqual(harness.scheduler.pendingCount, 0)
  }

  func testNotificationsDuringRecoveryCoalesceIntoOneRestartAndOneTap() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()

    harness.postConfigurationChange()
    harness.postConfigurationChange()
    harness.engine.onStart = { [weak harness] in
      harness?.postConfigurationChangeWithoutFlushing()
    }
    XCTAssertEqual(harness.scheduler.pendingCount, 1)
    harness.runNextScheduledAction()

    XCTAssertEqual(harness.engine.startCount, 2)
    XCTAssertEqual(harness.engine.maximumActiveTapCount, 1)
    XCTAssertEqual(harness.diagnostics, [])
  }

  func testRecoveryRechecksUIDAndLivenessBeforeEveryAttempt() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()
    harness.deviceStates = [.inactive]

    harness.postConfigurationChange()
    harness.runNextScheduledAction()

    XCTAssertEqual(
      harness.diagnostics,
      [MicrophoneCaptureDiagnostic.selectedDeviceInactive.rawValue]
    )
    XCTAssertEqual(harness.engine.stopCount, 1)

    let unavailable = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try unavailable.capture.start()
    unavailable.deviceStates = [.uidUnavailable]
    unavailable.postConfigurationChange()
    unavailable.runNextScheduledAction()
    XCTAssertEqual(
      unavailable.diagnostics,
      [MicrophoneCaptureDiagnostic.selectedUIDUnavailable.rawValue]
    )

    let queryFailure = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try queryFailure.capture.start()
    queryFailure.deviceStates = Array(repeating: .queryFailed, count: 5)
    queryFailure.postConfigurationChange()
    queryFailure.runAllScheduledActions()
    XCTAssertEqual(
      queryFailure.diagnostics,
      [MicrophoneCaptureDiagnostic.audioUnitSelectionFailed.rawValue]
    )
  }

  func testSelectionInitialStartAndRecoveryRestartDiagnosticsRemainDistinct() throws {
    let selection = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    selection.engine.selectionResults = [.failure(FakeEngineError.failed)]
    XCTAssertThrowsError(try selection.capture.start()) { error in
      guard let captureError = error as? DesktopMicrophoneCaptureError,
        case .selectedInputFailed = captureError
      else {
        return XCTFail("expected selectedInputFailed, got \(error)")
      }
      XCTAssertEqual(captureError.diagnostic, .audioUnitSelectionFailed)
    }

    let initialStart = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    initialStart.engine.startResults = [.failure(FakeEngineError.failed)]
    XCTAssertThrowsError(try initialStart.capture.start()) { error in
      guard let captureError = error as? DesktopMicrophoneCaptureError,
        case .engineStart = captureError
      else {
        return XCTFail("expected engineStart, got \(error)")
      }
      XCTAssertEqual(captureError.diagnostic, .initialEngineStartFailed)
    }

    let recovery = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try recovery.capture.start()
    recovery.engine.startResults = Array(
      repeating: .failure(FakeEngineError.failed),
      count: 5
    )
    recovery.postConfigurationChange()
    recovery.runAllScheduledActions()
    XCTAssertEqual(
      recovery.diagnostics,
      [MicrophoneCaptureDiagnostic.recoveryRestartFailed.rawValue]
    )

    let recoverySelection = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try recoverySelection.capture.start()
    recoverySelection.engine.selectionResults = Array(
      repeating: .failure(FakeEngineError.failed),
      count: 5
    )
    recoverySelection.postConfigurationChange()
    recoverySelection.runAllScheduledActions()
    XCTAssertEqual(
      recoverySelection.diagnostics,
      [MicrophoneCaptureDiagnostic.audioUnitSelectionFailed.rawValue]
    )
  }

  func testTeardownDuringRecoveryIsIdempotentAndLateAttemptCannotRestart() throws {
    let harness = RecoveryHarness(selectedDeviceUniqueID: "bluetooth")
    try harness.capture.start()
    harness.postConfigurationChange()
    XCTAssertEqual(harness.scheduler.pendingCount, 1)

    harness.capture.teardown()
    harness.capture.teardown()
    harness.runAllScheduledActions()
    harness.postConfigurationChange()

    XCTAssertEqual(harness.engine.startCount, 1)
    XCTAssertEqual(harness.engine.stopCount, 1)
    XCTAssertEqual(harness.engine.removeTapCount, 1)
    XCTAssertEqual(harness.engine.activeTapCount, 0)
    XCTAssertEqual(harness.scheduler.pendingCount, 0)
    XCTAssertEqual(harness.diagnostics, [])
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    samples: [Double]
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    try meterResult(format: format, channels: [samples], interleaved: false)
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    channels: [[Double]],
    interleaved: Bool
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    let buffer = try makeBuffer(format: format, channels: channels, interleaved: interleaved)
    guard case let .samples(_, rms, peak) = MicrophonePCMBufferMeter.measure(buffer) else {
      return nil
    }
    return (rms, peak)
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    integerMinimum: Bool
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    let buffer = try makeBuffer(format: format, channels: [[0]], interleaved: false)
    if integerMinimum, format == .pcmFormatInt16 {
      buffer.int16ChannelData![0][0] = Int16.min
    } else if integerMinimum, format == .pcmFormatInt32 {
      buffer.int32ChannelData![0][0] = Int32.min
    }
    guard case let .samples(_, rms, peak) = MicrophonePCMBufferMeter.measure(buffer) else {
      return nil
    }
    return (rms, peak)
  }

  private func makeBuffer(
    format commonFormat: AVAudioCommonFormat,
    channels: [[Double]],
    interleaved: Bool
  ) throws -> AVAudioPCMBuffer {
    let frameCount = channels.first?.count ?? 0
    XCTAssertTrue(channels.allSatisfy { $0.count == frameCount })
    let format = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: commonFormat,
        sampleRate: 48_000,
        channels: AVAudioChannelCount(channels.count),
        interleaved: interleaved
      )
    )
    let buffer = try XCTUnwrap(
      AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, frameCount)))
    )
    buffer.frameLength = AVAudioFrameCount(frameCount)
    let audioBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let stride = Int(buffer.stride)
    for channel in channels.indices {
      let audioBufferIndex = interleaved ? 0 : channel
      guard let rawData = audioBuffers[audioBufferIndex].mData else {
        throw XCTSkip("AVAudioPCMBuffer did not allocate sample memory")
      }
      for frame in 0..<frameCount {
        let offset = frame * stride + (interleaved ? channel : 0)
        switch commonFormat {
        case .pcmFormatFloat32:
          rawData.assumingMemoryBound(to: Float.self)[offset] = Float(channels[channel][frame])
        case .pcmFormatInt16:
          rawData.assumingMemoryBound(to: Int16.self)[offset] = Int16(
            (channels[channel][frame] * 32_768).rounded(.towardZero)
          )
        case .pcmFormatInt32:
          rawData.assumingMemoryBound(to: Int32.self)[offset] = Int32(
            (channels[channel][frame] * 2_147_483_648).rounded(.towardZero)
          )
        default:
          break
        }
      }
    }
    return buffer
  }

  private static func format(sampleRate: Double, channels: AVAudioChannelCount) -> AVAudioFormat {
    AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels)!
  }
}

private enum FakeEngineError: Error {
  case failed
}

private final class FakeMicrophoneCaptureEngine: NSObject, MicrophoneCaptureEngine {
  var format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
  var running = false
  var selectionResults: [Result<Void, FakeEngineError>] = []
  var startResults: [Result<Void, FakeEngineError>] = []
  var selectedDeviceIDs: [AudioDeviceID] = []
  var startCount = 0
  var activeFormatCount = 0
  var stopCount = 0
  var removeTapCount = 0
  var activeTapCount = 0
  var maximumActiveTapCount = 0
  var onStart: (() -> Void)?
  private var tapHandler: ((AVAudioPCMBuffer) -> Void)?

  var isRunning: Bool { running }
  var configurationChangeObject: AnyObject { self }

  func activeInputFormat() -> AVAudioFormat {
    activeFormatCount += 1
    return format
  }

  func selectInputDevice(_ deviceID: AudioDeviceID) throws {
    selectedDeviceIDs.append(deviceID)
    if !selectionResults.isEmpty {
      try selectionResults.removeFirst().get()
    }
  }

  func installTap(
    format: AVAudioFormat,
    _ handler: @escaping (AVAudioPCMBuffer) -> Void
  ) {
    activeTapCount += 1
    maximumActiveTapCount = max(maximumActiveTapCount, activeTapCount)
    tapHandler = handler
  }

  func removeTap() {
    removeTapCount += 1
    activeTapCount -= 1
    tapHandler = nil
  }

  func prepare() {}

  func start() throws {
    startCount += 1
    onStart?()
    if !startResults.isEmpty {
      try startResults.removeFirst().get()
    }
    running = true
  }

  func pause() { running = false }

  func stop() {
    stopCount += 1
    running = false
  }

  func emit(_ buffer: AVAudioPCMBuffer) {
    tapHandler?(buffer)
  }
}

private final class FakeMicrophoneCaptureScheduler: MicrophoneCaptureScheduling,
  @unchecked Sendable
{
  struct ScheduledAction {
    let delay: TimeInterval
    let action: @Sendable () -> Void
  }

  var now: TimeInterval = 0
  var actions: [ScheduledAction] = []
  var executedDelays: [TimeInterval] = []
  var pendingCount: Int { actions.count }

  func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () -> Void) {
    actions.append(ScheduledAction(delay: delay, action: action))
  }

  func runNext() {
    let next = actions.removeFirst()
    now += next.delay
    executedDelays.append(next.delay)
    next.action()
  }
}

private final class RecoveryHarness {
  let engine = FakeMicrophoneCaptureEngine()
  let scheduler = FakeMicrophoneCaptureScheduler()
  let queue = DispatchQueue(label: "MicrophoneCaptureTests.recovery")
  let notificationCenter = NotificationCenter()
  private(set) var diagnostics: [String] = []
  private(set) var deviceQueryCount = 0
  var deviceStates: [MicrophoneSelectedDeviceState] = []
  lazy var capture = MicrophoneCapture(
    selectedDeviceUniqueID: selectedDeviceUniqueID,
    engine: engine,
    scheduler: scheduler,
    recoveryQueue: queue,
    notificationCenter: notificationCenter,
    selectedDeviceQuery: { [weak self] _ in
      guard let self else { return .uidUnavailable }
      self.deviceQueryCount += 1
      return self.deviceStates.isEmpty ? .available(42) : self.deviceStates.removeFirst()
    },
    healthHandler: { [weak self] diagnostic in
      self?.diagnostics.append(diagnostic.rawValue)
    }
  )
  private let selectedDeviceUniqueID: String?

  init(selectedDeviceUniqueID: String?) {
    self.selectedDeviceUniqueID = selectedDeviceUniqueID
  }

  func postConfigurationChange() {
    postConfigurationChangeWithoutFlushing()
    flushRecoveryQueue()
  }

  func postConfigurationChangeWithoutFlushing() {
    notificationCenter.post(
      name: .AVAudioEngineConfigurationChange,
      object: engine.configurationChangeObject
    )
  }

  func runNextScheduledAction() {
    scheduler.runNext()
    flushRecoveryQueue()
  }

  func runAllScheduledActions() {
    while scheduler.pendingCount > 0 {
      runNextScheduledAction()
    }
  }

  func flushRecoveryQueue() {
    queue.sync {}
  }
}
