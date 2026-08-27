import AVFoundation
import Darwin
import Foundation

public struct CaptureFailure: Error, Sendable {
  public let code: String
  public let message: String

  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

public struct CapturePreflight: Codable, Sendable {
  public let minimumMacosVersion: String
  public let systemAudioMinimumMacosVersion: String
  public let captureMode: String
  public let systemAudioPermission: String
  public let microphonePermission: String
  public let microphones: [CaptureDevice]
  public let availableBytes: Int64
  public let requiredBytes: Int64
  public let captionModelAvailable: Bool
  public let canStart: Bool
  public let blockingReasons: [String]
}

public struct CaptureDevice: Codable, Sendable {
  public let id: String
  public let name: String
  public let isDefault: Bool
}

public struct CaptureSnapshot: Codable, Sendable {
  public let sessionId: String
  public let state: String
  public let captureMode: String
  public let captureTimelineMs: Int
  public let systemAudioHealthy: Bool
  public let microphoneHealthy: Bool
  public let partialCapture: Bool
  public let finalizedChunkCount: Int
  public let eventCount: Int
  public let gapCount: Int
  public let interruptionReason: String?
  public let recordingSha256: String?
  public let journalSha256: String?
  public let invalidFinalizedChunks: Int?
  public let quarantinedTailChunks: Int?

  enum CodingKeys: String, CodingKey {
    case sessionId, state, captureMode, captureTimelineMs
    case systemAudioHealthy, microphoneHealthy, partialCapture
    case finalizedChunkCount, eventCount, gapCount, interruptionReason
    case recordingSha256, journalSha256, invalidFinalizedChunks
    case quarantinedTailChunks
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(sessionId, forKey: .sessionId)
    try values.encode(state, forKey: .state)
    try values.encode(captureMode, forKey: .captureMode)
    try values.encode(captureTimelineMs, forKey: .captureTimelineMs)
    try values.encode(systemAudioHealthy, forKey: .systemAudioHealthy)
    try values.encode(microphoneHealthy, forKey: .microphoneHealthy)
    try values.encode(partialCapture, forKey: .partialCapture)
    try values.encode(finalizedChunkCount, forKey: .finalizedChunkCount)
    try values.encode(eventCount, forKey: .eventCount)
    try values.encode(gapCount, forKey: .gapCount)
    if let interruptionReason {
      try values.encode(interruptionReason, forKey: .interruptionReason)
    } else {
      try values.encodeNil(forKey: .interruptionReason)
    }
    if let recordingSha256 {
      try values.encode(recordingSha256, forKey: .recordingSha256)
    } else {
      try values.encodeNil(forKey: .recordingSha256)
    }
    try values.encodeIfPresent(journalSha256, forKey: .journalSha256)
    try values.encodeIfPresent(invalidFinalizedChunks, forKey: .invalidFinalizedChunks)
    try values.encodeIfPresent(quarantinedTailChunks, forKey: .quarantinedTailChunks)
  }
}

public struct MicrophoneTestSnapshot: Codable, Sendable {
  public let testId: String
  public let state: String
  public let reason: String?
  public let elapsedMs: Int
  public let normalizedRMS: Double
  public let normalizedPeak: Double
  public let observedFrames: UInt64
  public let observedSound: Bool
}

protocol MicrophoneTestEngine: AnyObject {
  func start() throws
  func stop()
  func setHealthHandler(_ handler: ((String) -> Void)?)
  func snapshot() -> MicrophoneCapture.MeterSnapshot
}

private final class NativeMicrophoneTestEngine: MicrophoneTestEngine {
  private let capture: MicrophoneCapture

  init(deviceId: String?) {
    capture = MicrophoneCapture(selectedDeviceUniqueID: deviceId)
  }

  func start() throws { try capture.start() }
  func stop() { capture.teardown() }
  func setHealthHandler(_ handler: ((String) -> Void)?) {
    capture.setHealthHandler(handler)
  }
  func snapshot() -> MicrophoneCapture.MeterSnapshot { capture.meterSnapshot() }
}

/// Owns the native authority tracks for one helper process. The helper remains
/// the sole caller, so commands are serialized by its line protocol while
/// audio callbacks serialize their durable writes inside CaptureChunkJournal.
public final class CaptureController {
  private let stateQueue = DispatchQueue(label: "com.voice2text.desktop.capture.core")
  private let captureRoot: URL
  private let rootIdentity: (device: UInt64, inode: UInt64)
  private var systemCapture: Any?
  private var microphoneCapture: MicrophoneCapture?
  private var journal: CaptureChunkJournal?
  private var diskMonitor: CaptureDiskMonitor?
  private var sessionID: String?
  private var sessionRoot: URL?
  private var state = "idle"
  private var captureMode = "dual_track"
  private var startedAt = DispatchTime.now()
  private var accumulatedMs = 0
  private var partialCapture = false
  private var systemHealthy = false
  private var microphoneHealthy = false
  private var interruptionReason: String?
  private var recordingSha256: String?
  private var journalSha256: String?
  private let microphoneTestFactory: (String?) -> MicrophoneTestEngine
  private let nowNanoseconds: () -> UInt64
  private var microphoneTest: MicrophoneTestEngine?
  private var microphoneTestID: String?
  private var microphoneTestStartedAt: UInt64 = 0
  private var microphoneTestObservedFrames: UInt64 = 0
  private var microphoneTestRMS: Double = 0
  private var microphoneTestPeak: Double = 0
  private var microphoneTestObservedSound = false
  private var lastMicrophoneTestSnapshot: MicrophoneTestSnapshot?

  public convenience init(captureRootPath: String) throws {
    try self.init(
      captureRootPath: captureRootPath,
      microphoneTestFactory: { NativeMicrophoneTestEngine(deviceId: $0) },
      nowNanoseconds: { DispatchTime.now().uptimeNanoseconds }
    )
  }

  init(
    captureRootPath: String,
    microphoneTestFactory: @escaping (String?) -> MicrophoneTestEngine,
    nowNanoseconds: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
  ) throws {
    let requestedRoot = URL(filePath: captureRootPath, directoryHint: .isDirectory)
      .standardizedFileURL
    guard requestedRoot.path.hasPrefix("/"), requestedRoot.path.utf8.count <= 2048 else {
      throw CaptureFailure("CAPTURE_ROOT_UNSAFE", "capture root is invalid")
    }
    var requestedInfo = stat()
    if lstat(requestedRoot.path, &requestedInfo) == 0,
      (requestedInfo.st_mode & S_IFMT) == S_IFLNK
    {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture root is a symbolic link")
    }
    try FileManager.default.createDirectory(
      at: requestedRoot,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    guard let canonicalPointer = realpath(requestedRoot.path, nil) else {
      throw CaptureFailure("CAPTURE_ROOT_UNSAFE", "capture root could not be canonicalized")
    }
    defer { free(canonicalPointer) }
    let root = URL(filePath: String(cString: canonicalPointer), directoryHint: .isDirectory)
    try Self.rejectSymlinkAncestors(root)
    var info = stat()
    guard lstat(root.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
      throw CaptureFailure("CAPTURE_ROOT_UNSAFE", "capture root is not a directory")
    }
    captureRoot = root
    rootIdentity = (UInt64(info.st_dev), UInt64(info.st_ino))
    self.microphoneTestFactory = microphoneTestFactory
    self.nowNanoseconds = nowNanoseconds
  }

  deinit { teardown() }

  public func preflight(
    minimumFreeBytes: Int64,
    captionModelAvailable: Bool,
    requestPermissions: Bool
  ) throws -> CapturePreflight {
    try stateQueue.sync {
      try preflightLocked(
        minimumFreeBytes: minimumFreeBytes,
        captionModelAvailable: captionModelAvailable,
        requestPermissions: requestPermissions
      )
    }
  }

  private func preflightLocked(
    minimumFreeBytes: Int64,
    captionModelAvailable: Bool,
    requestPermissions: Bool
  ) throws -> CapturePreflight {
    guard minimumFreeBytes >= 0, minimumFreeBytes <= 16 * 1024 * 1024 * 1024 * 1024 else {
      throw CaptureFailure("CAPTURE_ARGUMENTS_INVALID", "minimum free bytes is invalid")
    }
    try validateRootIdentity()
    var permission = MicrophoneCapture.permissionWireState()
    if requestPermissions, permission == "not_determined" {
      let semaphore = DispatchSemaphore(value: 0)
      MicrophoneCapture.requestPermission { granted in
        permission = granted ? "granted" : "denied"
        semaphore.signal()
      }
      if semaphore.wait(timeout: .now() + 15) == .timedOut {
        permission = MicrophoneCapture.permissionWireState()
      }
    }
    let available = (
      try? captureRoot.resourceValues(
        forKeys: [.volumeAvailableCapacityForImportantUsageKey]
      ).volumeAvailableCapacityForImportantUsage
    ) ?? 0
    let devices = MicrophoneCapture.devices()
    let supportsSystemAudio: Bool
    if #available(macOS 14.2, *) { supportsSystemAudio = true } else { supportsSystemAudio = false }
    return evaluateCapturePreflight(
      CapturePreflightInputs(
        microphonePermission: permission,
        microphones: devices,
        availableBytes: available,
        requiredBytes: minimumFreeBytes,
        captionModelAvailable: captionModelAvailable,
        supportsSystemAudio: supportsSystemAudio
      )
    )
  }

  public func start(
    sessionId: String,
    minimumFreeBytes: Int64,
    microphoneDeviceId: String?
  ) throws -> CaptureSnapshot {
    try stateQueue.sync {
      try startLocked(
        sessionId: sessionId,
        minimumFreeBytes: minimumFreeBytes,
        microphoneDeviceId: microphoneDeviceId
      )
    }
  }

  private func startLocked(
    sessionId: String,
    minimumFreeBytes: Int64,
    microphoneDeviceId: String?
  ) throws -> CaptureSnapshot {
    cancelActiveMicrophoneTestLocked()
    try validateRootIdentity()
    guard Self.validSessionID(sessionId), state == "idle" || state == "completed" || state == "failed" else {
      throw CaptureFailure("CAPTURE_ILLEGAL_TRANSITION", "capture cannot start in the current state")
    }
    let root = captureRoot.appendingPathComponent(sessionId, isDirectory: true)
    guard root.deletingLastPathComponent().standardizedFileURL == captureRoot else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session escaped its capability")
    }
    var rootInfo = stat()
    let rootStatus = lstat(root.path, &rootInfo)
    if rootStatus == 0 {
      guard (rootInfo.st_mode & S_IFMT) == S_IFDIR else {
        throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session is unsafe")
      }
    } else if errno != ENOENT {
      throw CaptureFailure("CAPTURE_ROOT_UNSAFE", "capture session could not be inspected")
    }
    state = "preparing"
    sessionID = sessionId
    sessionRoot = root
    accumulatedMs = 0
    partialCapture = false
    interruptionReason = nil
    recordingSha256 = nil
    journalSha256 = nil
    do {
      var microphone: MicrophoneCapture?
      var microphoneFormat: AVAudioFormat?
      var microphoneFailure: String?
      let candidateMicrophone = MicrophoneCapture(
        selectedDeviceUniqueID: microphoneDeviceId,
        healthHandler: { [weak self] reason in self?.enqueueTrackFailure(.microphone, reason: reason) }
      )
      do {
        try candidateMicrophone.start()
        guard let format = candidateMicrophone.format else {
          throw CaptureFailure("CAPTURE_NATIVE_START_FAILED", "microphone format is invalid")
        }
        microphone = candidateMicrophone
        microphoneFormat = format
      } catch {
        candidateMicrophone.teardown()
        microphoneFailure = "microphone_start_failed"
      }
      var system: Any?
      var systemFormat: AVAudioFormat?
      var systemFailure: String?
      if #available(macOS 14.2, *) {
        let candidateSystem = CoreAudioProcessTapCapture()
        do {
          try candidateSystem.start()
          guard let format = candidateSystem.format else {
            throw CaptureFailure("CAPTURE_NATIVE_START_FAILED", "system audio format is invalid")
          }
          system = candidateSystem
          systemFormat = format
        } catch {
          candidateSystem.teardown()
          systemFailure = "system_audio_start_failed"
        }
      } else {
        systemFailure = "system_audio_runtime_unsupported"
      }
      guard microphoneFormat != nil || systemFormat != nil else {
        throw CaptureFailure("CAPTURE_NATIVE_START_FAILED", "system audio format is invalid")
      }
      let mode = captureModeForAvailableTracks(
        systemAudio: systemFormat != nil,
        microphone: microphoneFormat != nil
      )
      let nextJournal = try CaptureChunkJournal(
        root: root,
        sessionID: sessionId,
        systemFormat: systemFormat,
        microphoneFormat: microphoneFormat,
        captureMode: mode,
        failureHandler: { [weak self] kind, reason in self?.enqueueTrackFailure(kind, reason: reason) }
      )
      try nextJournal.beginRecording()
      if #available(macOS 14.2, *), let system = system as? CoreAudioProcessTapCapture {
        system.setBufferHandler { [weak nextJournal] buffer in nextJournal?.append(buffer, to: .systemAudio) }
      }
      microphone?.setBufferHandler { [weak nextJournal] buffer in nextJournal?.append(buffer, to: .microphone) }
      systemCapture = system
      microphoneCapture = microphone
      journal = nextJournal
      captureMode = mode
      systemHealthy = systemFormat != nil
      microphoneHealthy = microphoneFormat != nil
      partialCapture = !(systemHealthy && microphoneHealthy)
      if let microphoneFailure {
        nextJournal.recordEvent(kind: "track_gap", track: "microphone", reason: microphoneFailure, at: 0)
      }
      if let systemFailure {
        nextJournal.recordEvent(kind: "track_gap", track: "system_audio", reason: systemFailure, at: 0)
      }
      startedAt = .now()
      state = partialCapture ? "partial_capture" : "recording"
      let monitor = CaptureDiskMonitor()
      monitor.start(root: root, minimumFreeBytes: minimumFreeBytes) { [weak self] _ in
        self?.stateQueue.async { [weak self] in self?.stopForLowDisk() }
      }
      diskMonitor = monitor
      return snapshot()
    } catch {
      teardown()
      state = "failed"
      if let failure = error as? CaptureFailure { throw failure }
      throw CaptureFailure("CAPTURE_NATIVE_START_FAILED", "native authority tracks could not start")
    }
  }

  public func startMicrophoneTest(
    testId: String,
    microphoneDeviceId: String?
  ) throws -> MicrophoneTestSnapshot {
    try stateQueue.sync {
      guard Self.validMicrophoneTestID(testId) else {
        throw CaptureFailure("MICROPHONE_TEST_ARGUMENTS_INVALID", "microphone test id is invalid")
      }
      guard state == "idle" || state == "completed" || state == "failed" else {
        throw CaptureFailure("MICROPHONE_TEST_BUSY", "formal capture owns the microphone")
      }
      guard microphoneTest == nil else {
        throw CaptureFailure("MICROPHONE_TEST_BUSY", "a microphone test is already active")
      }
      let engine = microphoneTestFactory(microphoneDeviceId)
      microphoneTest = engine
      microphoneTestID = testId
      microphoneTestStartedAt = nowNanoseconds()
      microphoneTestObservedFrames = 0
      microphoneTestRMS = 0
      microphoneTestPeak = 0
      microphoneTestObservedSound = false
      lastMicrophoneTestSnapshot = nil
      engine.setHealthHandler { [weak self] _ in
        self?.stateQueue.async { [weak self] in
          self?.failMicrophoneTestLocked(testId: testId, reason: "device-unavailable")
        }
      }
      do {
        try engine.start()
      } catch DesktopMicrophoneCaptureError.permissionDenied {
        return failMicrophoneTestLocked(testId: testId, reason: "permission-denied")
      } catch DesktopMicrophoneCaptureError.selectedInputUnavailable {
        return failMicrophoneTestLocked(testId: testId, reason: "device-unavailable")
      } catch DesktopMicrophoneCaptureError.noInputDevice {
        return failMicrophoneTestLocked(testId: testId, reason: "device-unavailable")
      } catch DesktopMicrophoneCaptureError.invalidFormat {
        return failMicrophoneTestLocked(testId: testId, reason: "unsupported-format")
      } catch DesktopMicrophoneCaptureError.selectedInputFailed {
        return failMicrophoneTestLocked(testId: testId, reason: "device-open-failed")
      } catch DesktopMicrophoneCaptureError.engineStart {
        return failMicrophoneTestLocked(testId: testId, reason: "device-open-failed")
      } catch {
        return failMicrophoneTestLocked(testId: testId, reason: "device-open-failed")
      }
      return microphoneTestSnapshotLocked()
    }
  }

  public func microphoneTestSnapshot(testId: String) throws -> MicrophoneTestSnapshot {
    try stateQueue.sync {
      if let terminal = lastMicrophoneTestSnapshot, terminal.testId == testId {
        return terminal
      }
      guard microphoneTestID == testId, microphoneTest != nil else {
        throw CaptureFailure("MICROPHONE_TEST_NOT_ACTIVE", "microphone test is not active")
      }
      return microphoneTestSnapshotLocked()
    }
  }

  public func finishMicrophoneTest(testId: String) throws -> MicrophoneTestSnapshot {
    try stateQueue.sync {
      if let terminal = lastMicrophoneTestSnapshot, terminal.testId == testId {
        return terminal
      }
      guard microphoneTestID == testId, microphoneTest != nil else {
        throw CaptureFailure("MICROPHONE_TEST_NOT_ACTIVE", "microphone test is not active")
      }
      let running = microphoneTestSnapshotLocked()
      if running.state == "failed" { return running }
      let reason = microphoneTestObservedFrames == 0
        ? "no-audio-frames"
        : (microphoneTestObservedSound ? "detected" : "no-sound-observed")
      let snapshot = makeMicrophoneTestSnapshot(state: "finished", reason: reason)
      lastMicrophoneTestSnapshot = snapshot
      releaseMicrophoneTestLocked()
      return snapshot
    }
  }

  public func cancelMicrophoneTest(testId: String) throws -> MicrophoneTestSnapshot {
    try stateQueue.sync {
      if let terminal = lastMicrophoneTestSnapshot, terminal.testId == testId {
        return terminal
      }
      guard microphoneTestID == testId, microphoneTest != nil else {
        throw CaptureFailure("MICROPHONE_TEST_NOT_ACTIVE", "microphone test is not active")
      }
      let snapshot = makeMicrophoneTestSnapshot(state: "cancelled", reason: nil)
      lastMicrophoneTestSnapshot = snapshot
      releaseMicrophoneTestLocked()
      return snapshot
    }
  }

  private func microphoneTestSnapshotLocked() -> MicrophoneTestSnapshot {
    guard let microphoneTest else {
      return makeMicrophoneTestSnapshot(state: "cancelled", reason: nil)
    }
    let meter = microphoneTest.snapshot()
    if meter.status == .unsupportedFormat {
      return failMicrophoneTestLocked(
        testId: microphoneTestID ?? "mic-test-unavailable",
        reason: "unsupported-format"
      )
    }
    microphoneTestObservedFrames = max(microphoneTestObservedFrames, meter.observedFrames)
    microphoneTestRMS = min(1, max(0, meter.normalizedRMS))
    microphoneTestPeak = min(1, max(0, meter.normalizedPeak))
    let soundFloor = pow(10, -55.0 / 20.0)
    if microphoneTestRMS >= soundFloor {
      microphoneTestObservedSound = true
    }
    return makeMicrophoneTestSnapshot(state: "running", reason: nil)
  }

  @discardableResult
  private func failMicrophoneTestLocked(
    testId: String,
    reason: String
  ) -> MicrophoneTestSnapshot {
    if let terminal = lastMicrophoneTestSnapshot, terminal.testId == testId {
      return terminal
    }
    guard microphoneTestID == testId else {
      return makeMicrophoneTestSnapshot(testId: testId, state: "failed", reason: reason)
    }
    let snapshot = makeMicrophoneTestSnapshot(state: "failed", reason: reason)
    lastMicrophoneTestSnapshot = snapshot
    releaseMicrophoneTestLocked()
    return snapshot
  }

  private func makeMicrophoneTestSnapshot(
    testId: String? = nil,
    state: String,
    reason: String?
  ) -> MicrophoneTestSnapshot {
    let now = nowNanoseconds()
    let elapsed = now >= microphoneTestStartedAt
      ? Int((now - microphoneTestStartedAt) / 1_000_000)
      : 0
    return MicrophoneTestSnapshot(
      testId: testId ?? microphoneTestID ?? "mic-test-unavailable",
      state: state,
      reason: reason,
      elapsedMs: elapsed,
      normalizedRMS: microphoneTestRMS,
      normalizedPeak: microphoneTestPeak,
      observedFrames: microphoneTestObservedFrames,
      observedSound: microphoneTestObservedSound
    )
  }

  private func cancelActiveMicrophoneTestLocked() {
    guard microphoneTest != nil, let testId = microphoneTestID else { return }
    lastMicrophoneTestSnapshot = makeMicrophoneTestSnapshot(
      testId: testId,
      state: "cancelled",
      reason: nil
    )
    releaseMicrophoneTestLocked()
  }

  private func releaseMicrophoneTestLocked() {
    microphoneTest?.setHealthHandler(nil)
    microphoneTest?.stop()
    microphoneTest = nil
    microphoneTestID = nil
  }

  public func pause(sessionId: String, reason: String? = nil) throws -> CaptureSnapshot {
    try stateQueue.sync { try pauseLocked(sessionId: sessionId, reason: reason) }
  }

  private func pauseLocked(sessionId: String, reason: String?) throws -> CaptureSnapshot {
    try requireSession(sessionId)
    guard state == "recording" || state == "partial_capture" else {
      throw CaptureFailure("CAPTURE_ILLEGAL_TRANSITION", "capture is not recording")
    }
    accumulatedMs = currentTimelineMs()
    if #available(macOS 14.2, *), let system = systemCapture as? CoreAudioProcessTapCapture { system.pause() }
    microphoneCapture?.pause()
    try journal?.pause(at: accumulatedMs)
    state = "paused"
    interruptionReason = reason
    if let reason {
      journal?.recordEvent(kind: "system_sleep", track: "all", reason: reason, at: accumulatedMs)
    }
    return snapshot()
  }

  public func resume(sessionId: String) throws -> CaptureSnapshot {
    try stateQueue.sync { try resumeLocked(sessionId: sessionId) }
  }

  private func resumeLocked(sessionId: String) throws -> CaptureSnapshot {
    try requireSession(sessionId)
    guard state == "paused" else {
      throw CaptureFailure("CAPTURE_ILLEGAL_TRANSITION", "capture is not paused")
    }
    if #available(macOS 14.2, *), let system = systemCapture as? CoreAudioProcessTapCapture { try system.start() }
    try microphoneCapture?.start()
    try journal?.resume(at: accumulatedMs, partial: partialCapture)
    startedAt = .now()
    state = partialCapture ? "partial_capture" : "recording"
    interruptionReason = nil
    return snapshot()
  }

  public func markWake(sessionId: String) throws -> CaptureSnapshot {
    try stateQueue.sync { try markWakeLocked(sessionId: sessionId) }
  }

  private func markWakeLocked(sessionId: String) throws -> CaptureSnapshot {
    try requireSession(sessionId)
    guard state == "paused" else { return snapshot() }
    journal?.recordEvent(kind: "system_wake", track: "all", reason: "manual_resume_required", at: accumulatedMs)
    interruptionReason = "system_wake_requires_resume"
    return snapshot()
  }

  public func stop(sessionId: String) throws -> CaptureSnapshot {
    try stateQueue.sync { try stopLocked(sessionId: sessionId) }
  }

  private func stopLocked(sessionId: String) throws -> CaptureSnapshot {
    try requireSession(sessionId)
    guard state == "recording" || state == "paused" || state == "partial_capture" else {
      throw CaptureFailure("CAPTURE_ILLEGAL_TRANSITION", "capture is not stoppable")
    }
    if state != "paused" { accumulatedMs = currentTimelineMs() }
    state = "finalizing"
    teardown()
    do {
      try journal?.finalize(at: accumulatedMs, partial: partialCapture)
      state = partialCapture ? "partial_capture" : "completed"
    } catch {
      partialCapture = true
      state = "recoverable"
      journal?.markRecoverable(at: accumulatedMs)
    }
    if let root = sessionRoot {
      let journalURL = root.appendingPathComponent("journal.json")
      journalSha256 = try? CaptureChunkJournal.sha256(journalURL)
      recordingSha256 = journalSha256
    }
    return snapshot()
  }

  public func currentSnapshot(sessionId: String) throws -> CaptureSnapshot {
    try stateQueue.sync { try currentSnapshotLocked(sessionId: sessionId) }
  }

  private func currentSnapshotLocked(sessionId: String) throws -> CaptureSnapshot {
    try requireSession(sessionId)
    return snapshot()
  }

  public func recover() throws -> [CaptureSnapshot] {
    try stateQueue.sync { try recoverLocked() }
  }

  private func recoverLocked() throws -> [CaptureSnapshot] {
    try validateRootIdentity()
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey]
    let children = try FileManager.default.contentsOfDirectory(
      at: captureRoot,
      includingPropertiesForKeys: Array(keys),
      options: [.skipsHiddenFiles]
    )
    guard children.count <= 256 else {
      throw CaptureFailure("CAPTURE_RECOVERY_LIMIT", "too many capture sessions")
    }
    return children.compactMap { child in
      guard Self.validSessionID(child.lastPathComponent),
        let values = try? child.resourceValues(forKeys: keys),
        values.isDirectory == true,
        values.isSymbolicLink != true,
        let report = CaptureChunkJournal.recoverSession(at: child)
      else { return nil }
      let journalHash = try? CaptureChunkJournal.sha256(
        child.appendingPathComponent("journal.json")
      )
      return Self.snapshot(report: report, journalHash: journalHash)
    }
  }

  public func discard(sessionId: String) throws {
    try stateQueue.sync { try discardLocked(sessionId: sessionId) }
  }

  private func discardLocked(sessionId: String) throws {
    try validateRootIdentity()
    guard Self.validSessionID(sessionId) else {
      throw CaptureFailure("CAPTURE_ARGUMENTS_INVALID", "capture session is invalid")
    }
    if sessionID == sessionId, ["recording", "paused", "partial_capture"].contains(state) {
      throw CaptureFailure("CAPTURE_ILLEGAL_TRANSITION", "active capture cannot be discarded")
    }
    let target = captureRoot.appendingPathComponent(sessionId, isDirectory: true)
    var info = stat()
    guard lstat(target.path, &info) == 0 else {
      if errno == ENOENT { return }
      throw CaptureFailure("CAPTURE_DISCARD_FAILED", "capture session could not be inspected")
    }
    guard (info.st_mode & S_IFMT) == S_IFDIR else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session is not a directory")
    }
    try FileManager.default.removeItem(at: target)
  }

  private func requireSession(_ requested: String) throws {
    try validateRootIdentity()
    guard requested == sessionID else {
      throw CaptureFailure("CAPTURE_SESSION_MISMATCH", "capture session does not match")
    }
  }

  private func snapshot() -> CaptureSnapshot {
    let durable = journal?.snapshot(
      systemHealthy: systemHealthy,
      microphoneHealthy: microphoneHealthy,
      partial: partialCapture
    )
    return CaptureSnapshot(
      sessionId: sessionID ?? "session-unavailable",
      state: state,
      captureMode: captureMode,
      captureTimelineMs: currentTimelineMs(),
      systemAudioHealthy: systemHealthy,
      microphoneHealthy: microphoneHealthy,
      partialCapture: partialCapture,
      finalizedChunkCount: durable?["finalizedChunkCount"] as? Int ?? 0,
      eventCount: durable?["eventCount"] as? Int ?? 0,
      gapCount: durable?["gapCount"] as? Int ?? 0,
      interruptionReason: interruptionReason,
      recordingSha256: recordingSha256,
      journalSha256: journalSha256,
      invalidFinalizedChunks: nil,
      quarantinedTailChunks: nil
    )
  }

  private static func snapshot(
    report: CaptureRecoveryReport,
    journalHash: String?
  ) -> CaptureSnapshot {
    CaptureSnapshot(
      sessionId: report.snapshot["sessionId"] as? String ?? "session-unavailable",
      state: report.snapshot["state"] as? String ?? "recoverable",
      captureMode: report.snapshot["captureMode"] as? String ?? "dual_track",
      captureTimelineMs: report.snapshot["captureTimelineMs"] as? Int ?? 0,
      systemAudioHealthy: false,
      microphoneHealthy: false,
      partialCapture: report.snapshot["partialCapture"] as? Bool ?? false,
      finalizedChunkCount: report.snapshot["finalizedChunkCount"] as? Int ?? 0,
      eventCount: report.snapshot["eventCount"] as? Int ?? 0,
      gapCount: report.snapshot["gapCount"] as? Int ?? 0,
      interruptionReason: "unexpected_exit",
      recordingSha256:
        report.snapshot["state"] as? String == "completed" ? journalHash : nil,
      journalSha256: journalHash,
      invalidFinalizedChunks: report.invalidFinalizedChunks,
      quarantinedTailChunks: report.quarantinedTailChunks
    )
  }

  private func currentTimelineMs() -> Int {
    let active = state == "recording" || state == "partial_capture"
    guard active else { return max(0, accumulatedMs) }
    let nanos = DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds
    return max(0, accumulatedMs + Int(nanos / 1_000_000))
  }

  private func trackFailed(_ kind: NativeCaptureTrack, reason: String) {
    let timeline = currentTimelineMs()
    partialCapture = true
    journal?.recordEvent(kind: "track_gap", track: kind.rawValue, reason: reason, at: timeline)
    switch kind {
    case .systemAudio:
      if #available(macOS 14.2, *), let system = systemCapture as? CoreAudioProcessTapCapture { system.teardown() }
      systemCapture = nil
      systemHealthy = false
    case .microphone:
      microphoneCapture?.teardown()
      microphoneCapture = nil
      microphoneHealthy = false
    }
    if systemHealthy || microphoneHealthy { state = "partial_capture" }
    else { stopForLowDisk() }
  }

  private func enqueueTrackFailure(_ kind: NativeCaptureTrack, reason: String) {
    stateQueue.async { [weak self] in self?.trackFailed(kind, reason: reason) }
  }

  private func stopForLowDisk() {
    guard ["recording", "paused", "partial_capture"].contains(state) else { return }
    let timeline = currentTimelineMs()
    partialCapture = true
    interruptionReason = "disk_space_low"
    journal?.recordEvent(kind: "disk_low", track: "all", reason: "minimum_free_bytes", at: timeline)
    accumulatedMs = timeline
    state = "finalizing"
    teardown()
    do {
      try journal?.finalize(at: timeline, partial: true)
      state = "partial_capture"
    } catch {
      journal?.markRecoverable(at: timeline)
      state = "failed"
    }
    if let root = sessionRoot {
      let journalURL = root.appendingPathComponent("journal.json")
      journalSha256 = try? CaptureChunkJournal.sha256(journalURL)
      recordingSha256 = journalSha256
    }
  }

  private func teardown() {
    cancelActiveMicrophoneTestLocked()
    diskMonitor?.stop()
    diskMonitor = nil
    if #available(macOS 14.2, *), let system = systemCapture as? CoreAudioProcessTapCapture { system.teardown() }
    systemCapture = nil
    microphoneCapture?.teardown()
    microphoneCapture = nil
    systemHealthy = false
    microphoneHealthy = false
  }

  private func validateRootIdentity() throws {
    var info = stat()
    guard lstat(captureRoot.path, &info) == 0,
      (info.st_mode & S_IFMT) == S_IFDIR,
      UInt64(info.st_dev) == rootIdentity.device,
      UInt64(info.st_ino) == rootIdentity.inode
    else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture root identity changed")
    }
  }

  private static func validSessionID(_ value: String) -> Bool {
    value.range(of: #"^session-[a-zA-Z0-9-]{12,120}$"#, options: .regularExpression) != nil
  }

  private static func validMicrophoneTestID(_ value: String) -> Bool {
    value.range(of: #"^mic-test-[a-zA-Z0-9-]{12,120}$"#, options: .regularExpression) != nil
  }

  private static func rejectSymlinkAncestors(_ root: URL) throws {
    var current = URL(filePath: "/", directoryHint: .isDirectory)
    for component in root.pathComponents.dropFirst() {
      current.append(path: component, directoryHint: .isDirectory)
      var info = stat()
      if lstat(current.path, &info) == 0 {
        guard (info.st_mode & S_IFMT) != S_IFLNK else {
          throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture root contains a symbolic link")
        }
      } else if errno != ENOENT {
        throw CaptureFailure("CAPTURE_ROOT_UNSAFE", "capture root could not be inspected")
      }
    }
  }
}

struct CapturePreflightInputs {
  let microphonePermission: String
  let microphones: [CaptureDevice]
  let availableBytes: Int64
  let requiredBytes: Int64
  let captionModelAvailable: Bool
  let supportsSystemAudio: Bool
}

func evaluateCapturePreflight(_ input: CapturePreflightInputs) -> CapturePreflight {
  var reasons = [String]()
  if input.microphonePermission != "granted" {
    reasons.append("microphone_permission_\(input.microphonePermission)")
  }
  if input.microphones.isEmpty { reasons.append("microphone_device_missing") }
  if input.availableBytes < input.requiredBytes { reasons.append("disk_space_low") }
  if !input.captionModelAvailable { reasons.append("caption_model_unavailable") }
  if !input.supportsSystemAudio { reasons.append("system_audio_runtime_unsupported") }
  let microphoneAvailable = input.microphonePermission == "granted" &&
    !input.microphones.isEmpty
  return CapturePreflight(
    minimumMacosVersion: "13.0",
    systemAudioMinimumMacosVersion: "14.2",
    captureMode: captureModeForAvailableTracks(
      systemAudio: input.supportsSystemAudio,
      microphone: microphoneAvailable
    ),
    systemAudioPermission: input.supportsSystemAudio ? "not_determined" : "unavailable",
    microphonePermission: input.microphonePermission,
    microphones: input.microphones,
    availableBytes: input.availableBytes,
    requiredBytes: input.requiredBytes,
    captionModelAvailable: input.captionModelAvailable,
    canStart: input.availableBytes >= input.requiredBytes &&
      (input.supportsSystemAudio || microphoneAvailable),
    blockingReasons: reasons
  )
}

func captureModeForAvailableTracks(systemAudio: Bool, microphone: Bool) -> String {
  if systemAudio && microphone { return "dual_track" }
  if systemAudio { return "system_audio_only" }
  return "microphone_only"
}
