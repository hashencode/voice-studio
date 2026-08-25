import AVFoundation
import Foundation
import XCTest
@testable import CaptureCore

final class CaptureControllerTests: XCTestCase {
  func testMicrophoneTestUsesInjectedEngineAndStopsWithoutCreatingCaptureFiles() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let engine = TestMicrophoneEngine()
    engine.frames = 1_024
    engine.peak = 0.2
    let controller = try CaptureController(
      captureRootPath: root.path,
      microphoneTestFactory: { _ in engine }
    )

    let started = try controller.startMicrophoneTest(
      testId: "mic-test-manual-stop-123456",
      microphoneDeviceId: "core-audio-device"
    )
    XCTAssertEqual(started.state, "running")
    let running = try controller.microphoneTestSnapshot(
      testId: started.testId
    )
    XCTAssertEqual(running.observedFrames, 1_024)
    XCTAssertTrue(running.detectedInput)
    let stopped = try controller.stopMicrophoneTest(testId: started.testId)
    XCTAssertEqual(stopped.state, "stopped")
    XCTAssertEqual(engine.stopCount, 1)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
  }

  func testMicrophoneTestRejectsConcurrentStartAndKeepsSilenceNonfatal() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let engine = TestMicrophoneEngine()
    let controller = try CaptureController(
      captureRootPath: root.path,
      microphoneTestFactory: { _ in engine }
    )
    let first = try controller.startMicrophoneTest(
      testId: "mic-test-silent-test-123456",
      microphoneDeviceId: nil
    )
    XCTAssertThrowsError(
      try controller.startMicrophoneTest(
        testId: "mic-test-second-test-123456",
        microphoneDeviceId: nil
      )
    )
    XCTAssertFalse(
      try controller.microphoneTestSnapshot(testId: first.testId).detectedInput
    )
    XCTAssertNoThrow(try controller.stopMicrophoneTest(testId: first.testId))
  }

  func testPreflightReportsEveryFrozenBranchWithoutBlockingOnOptionalCaptions() {
    let device = CaptureDevice(id: "microphone", name: "Mic", isDefault: true)
    let denied = evaluateCapturePreflight(
      CapturePreflightInputs(
        microphonePermission: "denied",
        microphones: [device],
        availableBytes: 10,
        requiredBytes: 1,
        captionModelAvailable: true,
        supportsSystemAudio: true
      )
    )
    XCTAssertEqual(denied.blockingReasons, ["microphone_permission_denied"])
    XCTAssertTrue(denied.canStart)
    XCTAssertEqual(denied.captureMode, "system_audio_only")

    let unavailable = evaluateCapturePreflight(
      CapturePreflightInputs(
        microphonePermission: "granted",
        microphones: [],
        availableBytes: 0,
        requiredBytes: 1,
        captionModelAvailable: false,
        supportsSystemAudio: false
      )
    )
    XCTAssertEqual(
      Set(unavailable.blockingReasons),
      Set([
        "microphone_device_missing", "disk_space_low",
        "caption_model_unavailable", "system_audio_runtime_unsupported",
      ])
    )
    XCTAssertFalse(unavailable.canStart)

    let captionsOnly = evaluateCapturePreflight(
      CapturePreflightInputs(
        microphonePermission: "granted",
        microphones: [device],
        availableBytes: 10,
        requiredBytes: 1,
        captionModelAvailable: false,
        supportsSystemAudio: true
      )
    )
    XCTAssertEqual(captionsOnly.blockingReasons, ["caption_model_unavailable"])
    XCTAssertTrue(captionsOnly.canStart)
  }

  func testCaptureModePreservesEitherHealthyAuthorityTrack() {
    XCTAssertEqual(captureModeForAvailableTracks(systemAudio: true, microphone: true), "dual_track")
    XCTAssertEqual(captureModeForAvailableTracks(systemAudio: true, microphone: false), "system_audio_only")
    XCTAssertEqual(captureModeForAvailableTracks(systemAudio: false, microphone: true), "microphone_only")
  }

  func testJournalSyncsFileBeforeItsParentDirectory() throws {
    let root = try temporaryRoot().appendingPathComponent(
      "session-durability-123456", isDirectory: true
    )
    defer {
      CaptureChunkJournal.durabilityObserver = nil
      try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1) else {
      return XCTFail("test format unavailable")
    }
    var events = [String]()
    CaptureChunkJournal.durabilityObserver = { events.append($0) }
    _ = try CaptureChunkJournal(
      root: root, sessionID: root.lastPathComponent,
      systemFormat: nil, microphoneFormat: format
    )
    let fileIndex = try XCTUnwrap(events.lastIndex(of: "file:journal.json"))
    let directoryIndex = try XCTUnwrap(events.lastIndex(of: "directory:root"))
    XCTAssertLessThan(fileIndex, directoryIndex)
  }

  func testFinalizedJournalBindsCompleteCaptionSpoolAndRecoveryRebuildsTruncation() throws {
    let parent = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: parent) }
    let session = parent.appendingPathComponent(
      "session-caption-authority-123456", isDirectory: true
    )
    guard
      let format = AVAudioFormat(
        standardFormatWithSampleRate: 48_000,
        channels: 1
      ),
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: 48_000
      )
    else {
      return XCTFail("test audio buffer unavailable")
    }
    buffer.frameLength = 48_000
    for index in 0..<Int(buffer.frameLength) {
      buffer.floatChannelData?[0][index] = sin(Float(index) / 20)
    }
    let journal = try CaptureChunkJournal(
      root: session,
      sessionID: session.lastPathComponent,
      systemFormat: nil,
      microphoneFormat: format,
      captureMode: "microphone_only"
    )
    try journal.beginRecording()
    journal.append(buffer, to: .microphone)
    try journal.finalize(at: 1_000, partial: false)

    let journalURL = session.appendingPathComponent("journal.json")
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: journalURL))
        as? [String: Any]
    )
    let spool = try XCTUnwrap(document["spool"] as? [String: Any])
    let bytes = try XCTUnwrap((spool["bytes"] as? NSNumber)?.intValue)
    XCTAssertGreaterThan(bytes, 0)
    XCTAssertEqual(bytes % 3_200, 0)
    XCTAssertEqual(spool["complete"] as? Bool, true)
    XCTAssertEqual(spool["disposable"] as? Bool, true)
    XCTAssertEqual(spool["formalEligible"] as? Bool, true)
    XCTAssertEqual((spool["durationMs"] as? NSNumber)?.intValue, bytes / 32)
    let originalSpoolHash = try CaptureChunkJournal.sha256(
      session.appendingPathComponent("caption/live-caption.pcmspool")
    )
    XCTAssertEqual(spool["sha256"] as? String, originalSpoolHash)

    try FileManager.default.removeItem(
      at: session.appendingPathComponent("caption/live-caption.pcmspool")
    )
    let report = try XCTUnwrap(CaptureChunkJournal.recoverSession(at: session))
    XCTAssertTrue(report.captionSpoolRebuilt)
    let rewritten = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: journalURL))
        as? [String: Any]
    )
    let rebuilt = try XCTUnwrap(rewritten["spool"] as? [String: Any])
    XCTAssertEqual(rebuilt["complete"] as? Bool, true)
    XCTAssertEqual(
      rebuilt["sha256"] as? String,
      try CaptureChunkJournal.sha256(
        session.appendingPathComponent("caption/live-caption.pcmspool")
      )
    )
    XCTAssertEqual(rebuilt["sha256"] as? String, originalSpoolHash)
    XCTAssertGreaterThan((rebuilt["bytes"] as? NSNumber)?.intValue ?? 0, 3_200)
    XCTAssertFalse(
      ((rewritten["chunks"] as? [[String: Any]]) ?? []).isEmpty,
      "CAF chunks remain the canonical recording authority"
    )

    let rebuiltBytes = try Data(
      contentsOf: session.appendingPathComponent("caption/live-caption.pcmspool")
    )
    try rebuiltBytes.dropLast(3_200).write(
      to: session.appendingPathComponent("caption/live-caption.pcmspool")
    )
    let truncated = try XCTUnwrap(CaptureChunkJournal.recoverSession(at: session))
    XCTAssertTrue(truncated.captionSpoolRebuilt)
    XCTAssertEqual(
      try CaptureChunkJournal.sha256(
        session.appendingPathComponent("caption/live-caption.pcmspool")
      ),
      originalSpoolHash
    )
  }

  func testCaptionSpoolAppendFailureDoesNotPoisonAuthorityTrack() throws {
    let parent = try temporaryRoot()
    defer {
      CaptureChunkJournal.captionSpoolAppendObserver = nil
      try? FileManager.default.removeItem(at: parent)
    }
    let session = parent.appendingPathComponent(
      "session-caption-degraded-123456", isDirectory: true
    )
    guard
      let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)
    else {
      return XCTFail("test audio buffer unavailable")
    }
    buffer.frameLength = 48_000
    CaptureChunkJournal.captionSpoolAppendObserver = {
      throw CocoaError(.fileWriteUnknown)
    }
    let journal = try CaptureChunkJournal(
      root: session,
      sessionID: session.lastPathComponent,
      systemFormat: nil,
      microphoneFormat: format,
      captureMode: "microphone_only"
    )
    try journal.beginRecording()
    journal.append(buffer, to: .microphone)
    try journal.finalize(at: 1_000, partial: false)

    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: Data(contentsOf: session.appendingPathComponent("journal.json"))
      ) as? [String: Any]
    )
    let track = try XCTUnwrap((document["tracks"] as? [[String: Any]])?.first)
    XCTAssertEqual(track["healthy"] as? Bool, true)
    XCTAssertEqual((document["chunks"] as? [[String: Any]])?.count, 1)
    XCTAssertEqual((document["spool"] as? [String: Any])?["formalEligible"] as? Bool, true)
  }

  func testCaptionSpoolRebuildFailureDoesNotBlockCompletedCaptureAuthority() throws {
    let parent = try temporaryRoot()
    defer {
      CaptureChunkJournal.captionSpoolRebuildObserver = nil
      try? FileManager.default.removeItem(at: parent)
    }
    let session = parent.appendingPathComponent(
      "session-caption-rebuild-fail-123456", isDirectory: true
    )
    guard
      let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)
    else {
      return XCTFail("test audio buffer unavailable")
    }
    buffer.frameLength = 48_000
    CaptureChunkJournal.captionSpoolRebuildObserver = {
      throw CocoaError(.fileWriteUnknown)
    }
    let journal = try CaptureChunkJournal(
      root: session,
      sessionID: session.lastPathComponent,
      systemFormat: nil,
      microphoneFormat: format,
      captureMode: "microphone_only"
    )
    try journal.beginRecording()
    journal.append(buffer, to: .microphone)
    XCTAssertNoThrow(try journal.finalize(at: 1_000, partial: false))

    let journalURL = session.appendingPathComponent("journal.json")
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: journalURL))
        as? [String: Any]
    )
    XCTAssertEqual(document["state"] as? String, "completed")
    XCTAssertEqual((document["chunks"] as? [[String: Any]])?.count, 1)
    XCTAssertNotNil(try? CaptureChunkJournal.sha256(journalURL))
    XCTAssertNotEqual(
      (document["spool"] as? [String: Any])?["formalEligible"] as? Bool,
      true
    )
  }

  func testCaptionSpoolFinalizeFailureDoesNotBlockCompletedCaptureAuthority() throws {
    let parent = try temporaryRoot()
    defer {
      CaptureChunkJournal.captionSpoolFinalizeObserver = nil
      try? FileManager.default.removeItem(at: parent)
    }
    let session = parent.appendingPathComponent(
      "session-caption-finalize-fail-123456", isDirectory: true
    )
    guard
      let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)
    else {
      return XCTFail("test audio buffer unavailable")
    }
    buffer.frameLength = 48_000
    let journal = try CaptureChunkJournal(
      root: session,
      sessionID: session.lastPathComponent,
      systemFormat: nil,
      microphoneFormat: format,
      captureMode: "microphone_only"
    )
    try journal.beginRecording()
    journal.append(buffer, to: .microphone)
    CaptureChunkJournal.captionSpoolFinalizeObserver = {
      throw CocoaError(.fileWriteUnknown)
    }
    XCTAssertNoThrow(try journal.finalize(at: 1_000, partial: false))
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: Data(contentsOf: session.appendingPathComponent("journal.json"))
      ) as? [String: Any]
    )
    XCTAssertEqual(document["state"] as? String, "completed")
    XCTAssertEqual((document["chunks"] as? [[String: Any]])?.count, 1)
    XCTAssertEqual((document["spool"] as? [String: Any])?["formalEligible"] as? Bool, true)
  }

  func testCompletedRecoveryQuarantinesInvalidChunksAndPublishesOnlyValidatedPrefix() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let session = root.appendingPathComponent("session-completed-corrupt-123456", isDirectory: true)
    let microphone = session.appendingPathComponent("microphone", isDirectory: true)
    try FileManager.default.createDirectory(at: microphone, withIntermediateDirectories: true)
    let valid = microphone.appendingPathComponent("chunk-000000.caf")
    let invalid = microphone.appendingPathComponent("chunk-000001.caf")
    try Data("valid authority".utf8).write(to: valid)
    try Data("corrupt authority".utf8).write(to: invalid)
    let journal: [String: Any] = [
      "schema": "desktop-capture-session/v1",
      "sessionId": session.lastPathComponent,
      "state": "completed",
      "captureMode": "microphone_only",
      "captureTimelineMs": 2_000,
      "tracks": [[
        "kind": "microphone", "healthy": true, "sampleRate": 48_000,
        "channels": 1, "format": "float32",
      ]],
      "chunks": [
        chunk("microphone/chunk-000000.caf", sequence: 0, bytes: 15, hash: try CaptureChunkJournal.sha256(valid)),
        chunk("microphone/chunk-000001.caf", sequence: 1, bytes: 17, hash: String(repeating: "0", count: 64)),
      ],
      "events": [],
    ]
    try JSONSerialization.data(withJSONObject: journal).write(
      to: session.appendingPathComponent("journal.json")
    )

    let recovered = try CaptureController(captureRootPath: root.path).recover()
    XCTAssertEqual(recovered.first?.state, "partial_capture")
    XCTAssertEqual(recovered.first?.finalizedChunkCount, 1)
    XCTAssertEqual(recovered.first?.invalidFinalizedChunks, 1)
    let rewritten = try JSONSerialization.jsonObject(
      with: Data(contentsOf: session.appendingPathComponent("journal.json"))
    ) as? [String: Any]
    XCTAssertEqual((rewritten?["chunks"] as? [[String: Any]])?.count, 1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: invalid.path))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: session.appendingPathComponent("quarantine/microphone-chunk-000001.caf").path
    ))
  }

  func testRecoveryIsBoundedAndIdempotent() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let session = root.appendingPathComponent("session-recovery-123456", isDirectory: true)
    try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)
    try fixtureJournal(sessionId: session.lastPathComponent).write(
      to: session.appendingPathComponent("journal.json"),
      options: .atomic
    )

    let controller = try CaptureController(captureRootPath: root.path)
    let first = try controller.recover()
    let firstHash = try CaptureChunkJournal.sha256(
      session.appendingPathComponent("journal.json")
    )
    let second = try controller.recover()
    let secondHash = try CaptureChunkJournal.sha256(
      session.appendingPathComponent("journal.json")
    )

    XCTAssertEqual(first.count, 1)
    XCTAssertEqual(first.first?.state, "recoverable")
    XCTAssertEqual(second.first?.sessionId, first.first?.sessionId)
    XCTAssertEqual(secondHash, firstHash)
  }

  func testDiscardRejectsSymlinkSession() throws {
    let root = try temporaryRoot()
    let outside = try temporaryRoot()
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: outside)
    }
    let controller = try CaptureController(captureRootPath: root.path)
    let link = root.appendingPathComponent("session-symlink-123456")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

    XCTAssertThrowsError(try controller.discard(sessionId: link.lastPathComponent))
    XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
  }

  func testSessionCaptionTrackAndQuarantineSymlinksFailClosed() throws {
    let root = try temporaryRoot()
    let outside = try temporaryRoot()
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: outside)
    }
    let sessionLink = root.appendingPathComponent("session-start-link-123456")
    try FileManager.default.createSymbolicLink(at: sessionLink, withDestinationURL: outside)
    let controller = try CaptureController(captureRootPath: root.path)
    XCTAssertThrowsError(
      try controller.start(sessionId: sessionLink.lastPathComponent, minimumFreeBytes: 0, microphoneDeviceId: nil)
    )

    guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1) else {
      return XCTFail("test format unavailable")
    }
    let captionSession = root.appendingPathComponent("session-caption-link-123456")
    try FileManager.default.createDirectory(at: captionSession, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
      at: captionSession.appendingPathComponent("caption"),
      withDestinationURL: outside
    )
    XCTAssertThrowsError(
      try CaptureChunkJournal(
        root: captionSession, sessionID: captionSession.lastPathComponent,
        systemFormat: nil, microphoneFormat: format
      )
    )

    let trackSession = root.appendingPathComponent("session-track-link-123456")
    try FileManager.default.createDirectory(at: trackSession, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
      at: trackSession.appendingPathComponent("microphone"),
      withDestinationURL: outside
    )
    XCTAssertThrowsError(
      try CaptureChunkJournal(
        root: trackSession, sessionID: trackSession.lastPathComponent,
        systemFormat: nil, microphoneFormat: format
      )
    )

    let quarantineSession = root.appendingPathComponent("session-quarantine-link-123456")
    try FileManager.default.createDirectory(at: quarantineSession, withIntermediateDirectories: false)
    try fixtureJournal(sessionId: quarantineSession.lastPathComponent).write(
      to: quarantineSession.appendingPathComponent("journal.json")
    )
    try FileManager.default.createSymbolicLink(
      at: quarantineSession.appendingPathComponent("quarantine"),
      withDestinationURL: outside
    )
    XCTAssertNil(CaptureChunkJournal.recoverSession(at: quarantineSession))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
  }

  func testRecoveryRejectsSessionRootReplacementAfterPinning() throws {
    let parent = try temporaryRoot()
    let outside = try temporaryRoot()
    defer {
      CaptureChunkJournal.recoveryRootPinnedObserver = nil
      try? FileManager.default.removeItem(at: parent)
      try? FileManager.default.removeItem(at: outside)
    }
    let session = parent.appendingPathComponent("session-replaced-123456")
    try FileManager.default.createDirectory(at: session, withIntermediateDirectories: false)
    try fixtureJournal(sessionId: session.lastPathComponent).write(
      to: session.appendingPathComponent("journal.json")
    )
    let pinnedOriginal = parent.appendingPathComponent("pinned-original")
    CaptureChunkJournal.recoveryRootPinnedObserver = {
      try! FileManager.default.moveItem(at: session, to: pinnedOriginal)
      try! FileManager.default.createSymbolicLink(at: session, withDestinationURL: outside)
    }
    XCTAssertNil(CaptureChunkJournal.recoverSession(at: session))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
  }

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "voice2text-capture-core-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    return root
  }

  private func fixtureJournal(sessionId: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1,
      "schema": "desktop-capture-session/v1",
      "sessionId": sessionId,
      "state": "recording",
      "captureMode": "dual_track",
      "captureTimelineMs": 0,
      "chunks": [],
      "events": [],
    ], options: [.sortedKeys])
  }

  private func chunk(
    _ relativePath: String,
    sequence: Int,
    bytes: Int,
    hash: String
  ) -> [String: Any] {
    [
      "track": "microphone", "sequence": sequence,
      "startMs": sequence * 1_000, "endMs": (sequence + 1) * 1_000,
      "relativePath": relativePath, "bytes": bytes,
      "sha256": hash, "finalized": true,
    ]
  }
}

private final class TestMicrophoneEngine: MicrophoneTestEngine {
  var frames: UInt64 = 0
  var peak: Double = 0
  var stopCount = 0

  func start() throws {}
  func stop() { stopCount += 1 }
  func snapshot() -> (observedFrames: UInt64, normalizedPeak: Double) {
    (frames, peak)
  }
}
