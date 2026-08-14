import AVFoundation
import CryptoKit
import Darwin
import Foundation

enum NativeCaptureTrack: String, CaseIterable {
  case systemAudio = "system_audio"
  case microphone

  var directoryName: String {
    switch self {
    case .systemAudio:
      return "system"
    case .microphone:
      return "microphone"
    }
  }
}

struct CaptureRecoveryReport {
  let snapshot: [String: Any]
  let recoveryMs: Int
  let quarantinedTailChunks: Int
  let invalidFinalizedChunks: Int
  let captionSpoolRebuilt: Bool
  let captionSpoolUsable: Bool
}

/// Serializes independently playable authority-track chunks and publishes their
/// hashes to an atomic write-ahead journal only after each file is durable.
final class CaptureChunkJournal {
#if DEBUG
  nonisolated(unsafe) static var durabilityObserver: ((String) -> Void)?
  nonisolated(unsafe) static var recoveryRootPinnedObserver: (() -> Void)?
  nonisolated(unsafe) static var captionSpoolAppendObserver: (() throws -> Void)?
  nonisolated(unsafe) static var captionSpoolRebuildObserver: (() throws -> Void)?
  nonisolated(unsafe) static var captionSpoolFinalizeObserver: (() throws -> Void)?
#endif
  private static let maximumChunks = 100_000
  private static let maximumEvents = 100_000
  private let queue = DispatchQueue(
    label: "com.voice2text.desktop.capture.chunks",
    qos: .utility
  )
  private let root: URL
  private let rootDescriptor: Int32
  private let rootIdentity: (UInt64, UInt64)
  private let journalURL: URL
  private let sessionID: String
  private let captureMode: String
  private let createdAtMs: Int
  private var state = "preparing"
  private var captureTimelineMs = 0
  private var chunks = [[String: Any]]()
  private var events = [[String: Any]]()
  private var writers = [NativeCaptureTrack: CaptureTrackChunkWriter]()
  private var tracks = [[String: Any]]()
  private var failedTracks = Set<NativeCaptureTrack>()
  private var captionSpool: CaptionPcmSpoolWriter?
  private var finalizedCaptionSpool: [String: Any]?
  private let failureHandler: ((NativeCaptureTrack, String) -> Void)?

  init(
    root: URL,
    sessionID: String,
    systemFormat: AVAudioFormat?,
    microphoneFormat: AVAudioFormat?,
    captureMode: String = "dual_track",
    chunkDurationMs: Int = 5000,
    failureHandler: ((NativeCaptureTrack, String) -> Void)? = nil
  ) throws {
    self.root = root
    self.sessionID = sessionID
    self.captureMode = captureMode
    journalURL = root.appendingPathComponent("journal.json")
    createdAtMs = Self.wallClockMs()
    self.failureHandler = failureHandler
    try Self.createPrivateDirectory(root)
    let descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session root is unsafe")
    }
    var rootInfo = stat()
    guard fstat(descriptor, &rootInfo) == 0 else {
      close(descriptor)
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session root is unavailable")
    }
    rootDescriptor = descriptor
    rootIdentity = (UInt64(rootInfo.st_dev), UInt64(rootInfo.st_ino))
    try Self.createPrivateDirectory(
      root.appendingPathComponent("caption", isDirectory: true)
    )
    let spool = root.appendingPathComponent(
      "caption/live-caption.pcmspool",
      isDirectory: false
    )
    var spoolInfo = stat()
    if lstat(spool.path, &spoolInfo) == 0 {
      guard (spoolInfo.st_mode & S_IFMT) == S_IFREG, spoolInfo.st_nlink == 1 else {
        throw CaptureFailure("HELPER_CAPABILITY_DENIED", "caption spool is unsafe")
      }
    } else {
      guard errno == ENOENT else { throw CocoaError(.fileWriteUnknown) }
      let descriptor = open(spool.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
      close(descriptor)
      try Self.synchronizeDirectory(spool.deletingLastPathComponent())
    }
    var formats = [(NativeCaptureTrack, AVAudioFormat)]()
    if let systemFormat {
      formats.append((.systemAudio, systemFormat))
    }
    if let microphoneFormat {
      formats.append((.microphone, microphoneFormat))
    }
    captionSpool = try CaptionPcmSpoolWriter(url: spool, formats: formats)
    for (kind, format) in formats {
      let directory = root.appendingPathComponent(
        kind.directoryName,
        isDirectory: true
      )
      try Self.createPrivateDirectory(directory)
      writers[kind] = try CaptureTrackChunkWriter(
        kind: kind,
        directory: directory,
        relativeDirectory: kind.directoryName,
        format: format,
        chunkDurationMs: chunkDurationMs
      )
      tracks.append([
        "kind": kind.rawValue,
        "healthy": true,
        "sampleRate": format.sampleRate,
        "channels": Int(format.channelCount),
        "format": Self.formatName(format),
      ])
    }
    try persist()
  }

  deinit { close(rootDescriptor) }

  func beginRecording() throws {
    try queue.sync {
      state = "recording"
      try persist()
    }
  }

  func append(_ buffer: AVAudioPCMBuffer, to kind: NativeCaptureTrack) {
    queue.async { [weak self] in
      guard let self, let writer = self.writers[kind] else { return }
      guard !self.failedTracks.contains(kind) else { return }
      guard self.chunks.count < Self.maximumChunks else {
        self.markTrackFailed(kind, reason: "chunk_limit_exceeded")
        return
      }
      do {
        do {
#if DEBUG
          try Self.captionSpoolAppendObserver?()
#endif
          try self.captionSpool?.append(buffer, track: kind)
        } catch {
          try? self.captionSpool?.finalize()
          self.captionSpool = nil
          self.recordEvent(
            kind: "caption_degraded",
            track: kind.rawValue,
            reason: "caption_spool_append_failed",
            at: self.captureTimelineMs
          )
        }
        if let chunk = try writer.append(buffer) {
          self.triggerDevelopmentCrash(stage: "during_finalize", code: 87)
          self.chunks.append(chunk)
          try self.persist()
          self.triggerDevelopmentCrash(stage: "after_journal", code: 88)
        } else {
          self.triggerDevelopmentCrash(stage: "during_write", code: 86)
        }
      } catch {
        self.markTrackFailed(kind, reason: "chunk_write_failed: \(error)")
      }
    }
  }

  func pause(at timelineMs: Int) throws {
    try queue.sync {
      try finalizeOpenChunks()
      captureTimelineMs = max(captureTimelineMs, timelineMs)
      state = "paused"
      try persist()
    }
  }

  func resume(at timelineMs: Int, partial: Bool = false) throws {
    try queue.sync {
      captureTimelineMs = max(captureTimelineMs, timelineMs)
      state = partial ? "partial_capture" : "recording"
      try persist()
    }
  }

  func recordEvent(
    kind: String,
    track: String,
    reason: String,
    at timelineMs: Int
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      guard self.events.count < Self.maximumEvents else { return }
      self.captureTimelineMs = max(self.captureTimelineMs, timelineMs)
      self.events.append([
        "sequence": self.events.count,
        "monotonicMs": max(0, timelineMs),
        "kind": kind,
        "track": track,
        "reason": String(reason.prefix(240)),
      ])
      try? self.persist()
    }
  }

  func finalize(at timelineMs: Int, partial: Bool) throws {
    try queue.sync {
      state = "finalizing"
      captureTimelineMs = max(captureTimelineMs, timelineMs)
      try persist()
      try finalizeOpenChunks()
      do {
#if DEBUG
        try Self.captionSpoolFinalizeObserver?()
#endif
        try captionSpool?.finalize()
      } catch {
        try? captionSpool?.finalize()
        if events.count < Self.maximumEvents {
          events.append([
            "sequence": events.count,
            "monotonicMs": max(0, captureTimelineMs),
            "kind": "caption_degraded",
            "track": "all",
            "reason": "caption_spool_finalize_failed",
          ])
        }
      }
      captionSpool = nil
      let expectedDurationMs = Self.maximumChunkEndMs(chunks)
      if Self.rebuildCaptionSpoolIfNeeded(at: root, validatedChunks: chunks) {
        finalizedCaptionSpool = try? Self.captionSpoolAuthority(
          at: root,
          captureTimelineMs: captureTimelineMs,
          expectedDurationMs: expectedDurationMs,
          gapCount: Self.gapCount(events)
        )
      }
      if finalizedCaptionSpool == nil, events.count < Self.maximumEvents {
        events.append([
          "sequence": events.count,
          "monotonicMs": max(0, captureTimelineMs),
          "kind": "caption_degraded",
          "track": "all",
          "reason": "caption_spool_rebuild_failed",
        ])
      }
      state = partial ? "partial_capture" : "completed"
      try persist()
    }
  }

  func markRecoverable(at timelineMs: Int) {
    queue.sync {
      captureTimelineMs = max(captureTimelineMs, timelineMs)
      state = "recoverable"
      try? persist()
    }
  }

  func snapshot(
    systemHealthy: Bool,
    microphoneHealthy: Bool,
    partial: Bool
  ) -> [String: Any] {
    queue.sync {
      [
        "sessionId": sessionID,
        "state": state,
        "captureTimelineMs": captureTimelineMs,
        "systemAudioHealthy": systemHealthy,
        "microphoneHealthy": microphoneHealthy,
        "partialCapture": partial,
        "finalizedChunkCount": chunks.count,
        "eventCount": events.count,
        "gapCount": events.filter {
          ($0["kind"] as? String) == "track_gap" ||
            ($0["kind"] as? String) == "device_changed" ||
            ($0["kind"] as? String) == "encoder_failed"
        }.count,
      ]
    }
  }

  func finalizedChunks() -> [[String: Any]] {
    queue.sync { chunks }
  }

  func committedFramesByTrack() -> [String: UInt64] {
    queue.sync {
      Dictionary(
        uniqueKeysWithValues: NativeCaptureTrack.allCases.map { kind in
          (kind.rawValue, UInt64(max(0, writers[kind]?.committedFrames ?? 0)))
        }
      )
    }
  }

  private func finalizeOpenChunks() throws {
    for kind in NativeCaptureTrack.allCases {
      guard let chunk = try writers[kind]?.finalizeOpenChunk() else {
        continue
      }
      guard chunks.count < Self.maximumChunks else {
        throw NSError(domain: "CaptureChunkJournal", code: 100_001)
      }
      chunks.append(chunk)
      try persist()
    }
  }

  private func markTrackFailed(
    _ kind: NativeCaptureTrack,
    reason: String
  ) {
    guard failedTracks.insert(kind).inserted else { return }
    if let index = tracks.firstIndex(
      where: { $0["kind"] as? String == kind.rawValue }
    ) {
      tracks[index]["healthy"] = false
    }
    events.append([
      "sequence": events.count,
      "monotonicMs": captureTimelineMs,
      "kind": "encoder_failed",
      "track": kind.rawValue,
      "reason": String(reason.prefix(240)),
    ])
    state = "partial_capture"
    try? persist()
    failureHandler?(kind, reason)
  }

  private func triggerDevelopmentCrash(stage: String, code: Int32) {
#if DEBUG
    guard
      ProcessInfo.processInfo.environment[
        "VOICE2TEXT_U12_CRASH_STAGE"
      ] == stage
    else {
      return
    }
    _exit(code)
#endif
  }

  private func persist() throws {
    let now = Self.wallClockMs()
    let document: [String: Any] = [
      "schema": "desktop-capture-session/v1",
      "sessionId": sessionID,
      "captureMode": captureMode,
      "state": state,
      "captureTimelineMs": captureTimelineMs,
      "createdAtMs": createdAtMs,
      "updatedAtMs": now,
      "tracks": tracks,
      "chunks": chunks,
      "events": events,
      "spool": finalizedCaptionSpool ?? [
        "relativePath": "caption/live-caption.pcmspool",
        "format": "s16le",
        "sampleRate": 16000,
        "channels": 1,
        "frameDurationMs": 100,
        "disposable": true,
      ],
      "recordingId": NSNull(),
      "recordingSha256": NSNull(),
    ]
    let data = try JSONSerialization.data(
      withJSONObject: document,
      options: [.prettyPrinted, .sortedKeys]
    )
    try validateRootIdentity()
    try Self.atomicWrite(
      data,
      fileName: journalURL.lastPathComponent,
      directoryDescriptor: rootDescriptor
    )
  }

  static func recoverSession(at root: URL) -> CaptureRecoveryReport? {
    let started = DispatchTime.now()
    let rootDescriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootDescriptor >= 0 else { return nil }
    defer { close(rootDescriptor) }
    var pinnedRoot = stat()
    guard fstat(rootDescriptor, &pinnedRoot) == 0 else { return nil }
#if DEBUG
    recoveryRootPinnedObserver?()
#endif
    guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
    let journalURL = root.appendingPathComponent("journal.json")
    guard
      let journalRead = try? readPinnedRegularFile(
        journalURL,
        expectedBytes: nil,
        maximumBytes: 64 * 1024 * 1024,
        collect: true
      ),
      let data = journalRead.data,
      var document = try? JSONSerialization.jsonObject(with: data)
        as? [String: Any],
      let sessionID = document["sessionId"] as? String,
      let chunks = document["chunks"] as? [[String: Any]]
    else {
      return nil
    }

    var invalidFinalized = 0
    var referenced = Set<String>()
    var validatedChunks = [[String: Any]]()
    var lastSafeChunkMs = 0
    for chunk in chunks {
      guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
      guard
        let relativePath = chunk["relativePath"] as? String,
        !relativePath.hasPrefix("/"),
        !relativePath.contains(".."),
        let expectedBytes = (chunk["bytes"] as? NSNumber)?.int64Value,
        let expectedHash = chunk["sha256"] as? String,
        let endMs = (chunk["endMs"] as? NSNumber)?.intValue,
        endMs >= 0
      else {
        invalidFinalized += 1
        continue
      }
      let file = root.appendingPathComponent(relativePath).standardizedFileURL
      guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
        let pinned = try? readPinnedRegularFile(
          file,
          expectedBytes: expectedBytes,
          maximumBytes: 8 * 1024 * 1024 * 1024,
          collect: false
        ),
        pinned.sha256 == expectedHash
      else {
        invalidFinalized += 1
        continue
      }
      referenced.insert(relativePath)
      validatedChunks.append(chunk)
      lastSafeChunkMs = max(lastSafeChunkMs, endMs)
    }

    let quarantine = root.appendingPathComponent(
      "quarantine",
      isDirectory: true
    )
    guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
    do {
      try createPrivateDirectory(quarantine)
    } catch {
      return nil
    }
    var quarantined = 0
    for kind in NativeCaptureTrack.allCases {
      guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
      let directory = root.appendingPathComponent(
        kind.directoryName,
        isDirectory: true
      )
      var directoryInfo = stat()
      if lstat(directory.path, &directoryInfo) == 0,
        (directoryInfo.st_mode & S_IFMT) != S_IFDIR
      {
        return nil
      }
      let children = (
        try? FileManager.default.contentsOfDirectory(
          at: directory,
          includingPropertiesForKeys: nil,
          options: [.skipsHiddenFiles]
        )
      ) ?? []
      let tails = children.filter { child in
        let relative = "\(kind.directoryName)/\(child.lastPathComponent)"
        return child.pathExtension == "partial" ||
          (child.pathExtension == "caf" && !referenced.contains(relative))
      }
      for tail in tails {
        let destination = quarantine.appendingPathComponent(
          "\(kind.directoryName)-\(tail.lastPathComponent)"
        )
        var destinationInfo = stat()
        guard lstat(destination.path, &destinationInfo) != 0, errno == ENOENT else {
          continue
        }
        if (try? FileManager.default.moveItem(
          at: tail,
          to: destination
        )) != nil {
          try? synchronizeDirectory(directory)
          try? synchronizeDirectory(quarantine)
          quarantined += 1
        }
      }
    }

    let spoolWasBound = captionSpoolMatchesJournal(at: root, document: document)
    let previousSpool = document["spool"] as? NSDictionary
    let captionSpoolRebuilt = spoolWasBound ? false : rebuildCaptionSpoolIfNeeded(
      at: root, validatedChunks: validatedChunks
    )
    let captionSpoolUsable = hasCompleteCaptionFrame(at: root)
    let recordedTimelineMs =
      (document["captureTimelineMs"] as? NSNumber)?.intValue ?? lastSafeChunkMs
    if captionSpoolUsable,
      let authority = try? captionSpoolAuthority(
        at: root,
        captureTimelineMs: max(recordedTimelineMs, lastSafeChunkMs),
        expectedDurationMs: maximumChunkEndMs(validatedChunks),
        gapCount: gapCount((document["events"] as? [[String: Any]]) ?? [])
      )
    {
      document["spool"] = authority
    } else if !spoolWasBound {
      document["spool"] = [
        "relativePath": "caption/live-caption.pcmspool",
        "format": "s16le",
        "sampleRate": 16_000,
        "channels": 1,
        "frameDurationMs": 100,
        "disposable": true,
        "complete": false,
        "formalEligible": false,
        "error": "caption_spool_rebuild_failed",
      ]
    }
    let spoolProofChanged = !(previousSpool?.isEqual(to: document["spool"] as? [AnyHashable: Any] ?? [:]) ?? false)

    if document["state"] as? String != "completed" || invalidFinalized > 0 || spoolProofChanged {
      guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
      let previousState = document["state"] as? String
      let recordedTimelineMs =
        (document["captureTimelineMs"] as? NSNumber)?.intValue ?? 0
      let recoveredTimelineMs = max(recordedTimelineMs, lastSafeChunkMs)
      let recoveredState: String
      if invalidFinalized > 0 || previousState == "partial_capture" || previousState == "failed" {
        recoveredState = "partial_capture"
      } else if previousState == "completed" {
        recoveredState = "completed"
      } else {
        recoveredState = "recoverable"
      }
      if invalidFinalized > 0 ||
        previousState != recoveredState ||
        recordedTimelineMs != recoveredTimelineMs ||
        spoolProofChanged
      {
        document["captureTimelineMs"] = recoveredTimelineMs
        document["state"] = recoveredState
        document["chunks"] = validatedChunks
        document["updatedAtMs"] = wallClockMs()
        if let updated = try? JSONSerialization.data(
          withJSONObject: document,
          options: [.prettyPrinted, .sortedKeys]
        ) {
          try? atomicWrite(
            updated,
            fileName: journalURL.lastPathComponent,
            directoryDescriptor: rootDescriptor
          )
        }
      }
    }
    let elapsedNanos = DispatchTime.now().uptimeNanoseconds -
      started.uptimeNanoseconds
    let snapshot: [String: Any] = [
      "sessionId": sessionID,
      "state": document["state"] as? String ?? "recoverable",
      "captureMode": document["captureMode"] as? String ?? "dual_track",
      "captureTimelineMs":
        (document["captureTimelineMs"] as? NSNumber)?.intValue ?? 0,
      "systemAudioHealthy": false,
      "microphoneHealthy": false,
      "partialCapture": invalidFinalized > 0 ||
        document["state"] as? String == "partial_capture",
      "finalizedChunkCount": validatedChunks.count,
      "eventCount": (document["events"] as? [Any])?.count ?? 0,
      "gapCount": (document["events"] as? [[String: Any]])?.filter {
        ($0["kind"] as? String) == "track_gap" ||
          ($0["kind"] as? String) == "device_changed" ||
          ($0["kind"] as? String) == "encoder_failed"
      }.count ?? 0,
    ]
    guard directoryIdentityMatches(root, pinnedRoot) else { return nil }
    return CaptureRecoveryReport(
      snapshot: snapshot,
      recoveryMs: Int(elapsedNanos / 1_000_000),
      quarantinedTailChunks: quarantined,
      invalidFinalizedChunks: invalidFinalized,
      captionSpoolRebuilt: captionSpoolRebuilt,
      captionSpoolUsable: captionSpoolUsable
    )
  }

  /// The caption spool is disposable and may be empty when the process exits
  /// before both live inputs have supplied a complete mixed frame. Recovery
  /// rebuilds that derived artifact from hash-validated authority CAF chunks,
  /// keeping those authority files as the canonical recording.
  private static func rebuildCaptionSpoolIfNeeded(
    at root: URL,
    validatedChunks: [[String: Any]]
  ) -> Bool {
    var chunksByTrack = [NativeCaptureTrack: [[String: Any]]]()
    for track in NativeCaptureTrack.allCases {
      let matching = validatedChunks
        .filter { $0["track"] as? String == track.rawValue }
        .sorted {
          (($0["sequence"] as? NSNumber)?.intValue ?? Int.max) <
            (($1["sequence"] as? NSNumber)?.intValue ?? Int.max)
        }
      if !matching.isEmpty {
        chunksByTrack[track] = matching
      }
    }
    let activeTracks = NativeCaptureTrack.allCases.filter {
      chunksByTrack[$0]?.isEmpty == false
    }
    guard !activeTracks.isEmpty else { return false }

    let captionDirectory = root.appendingPathComponent(
      "caption",
      isDirectory: true
    )
    let spool = captionDirectory.appendingPathComponent(
      "live-caption.pcmspool",
      isDirectory: false
    )
    let temporary = captionDirectory.appendingPathComponent(
      ".live-caption-recovery-\(UUID().uuidString).pcmspool",
      isDirectory: false
    )

    do {
#if DEBUG
      try captionSpoolRebuildObserver?()
#endif
      try createPrivateDirectory(captionDirectory)
      FileManager.default.createFile(
        atPath: temporary.path,
        contents: Data(),
        attributes: [.posixPermissions: 0o600]
      )
      defer { try? FileManager.default.removeItem(at: temporary) }

      var formats = [(NativeCaptureTrack, AVAudioFormat)]()
      for track in activeTracks {
        guard
          let chunk = chunksByTrack[track]?.first,
          let relativePath = chunk["relativePath"] as? String
        else {
          throw CocoaError(.fileReadCorruptFile)
        }
        let audio = try AVAudioFile(
          forReading: root.appendingPathComponent(relativePath)
        )
        formats.append((track, audio.processingFormat))
      }

      let writer = try CaptionPcmSpoolWriter(
        url: temporary,
        formats: formats
      )
      let maximumChunkCount = chunksByTrack.values
        .map(\.count)
        .max() ?? 0
      for chunkIndex in 0..<maximumChunkCount {
        for track in activeTracks {
          guard
            let trackChunks = chunksByTrack[track],
            chunkIndex < trackChunks.count,
            let relativePath =
              trackChunks[chunkIndex]["relativePath"] as? String
          else {
            continue
          }
          try appendAuthorityChunk(
            root.appendingPathComponent(relativePath),
            track: track,
            to: writer,
            expectedFormat: formats.first {
              $0.0 == track
            }?.1
          )
        }
      }
      try writer.finalize()
      let recoveredBytes = (
        try temporary.resourceValues(forKeys: [.fileSizeKey])
      ).fileSize ?? 0
      guard recoveredBytes >= CaptionPcmSpoolWriter.frameBytes else {
        throw CocoaError(.fileReadCorruptFile)
      }
      if FileManager.default.fileExists(atPath: spool.path) {
        try FileManager.default.removeItem(at: spool)
      }
      try FileManager.default.moveItem(at: temporary, to: spool)
      try synchronize(spool)
      try synchronizeDirectory(captionDirectory)
      return true
    } catch {
      return false
    }
  }

  private static func appendAuthorityChunk(
    _ url: URL,
    track: NativeCaptureTrack,
    to writer: CaptionPcmSpoolWriter,
    expectedFormat: AVAudioFormat?
  ) throws {
    guard let expectedFormat else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let audio = try AVAudioFile(forReading: url)
    let format = audio.processingFormat
    guard
      format.sampleRate == expectedFormat.sampleRate,
      format.channelCount == expectedFormat.channelCount,
      format.commonFormat == expectedFormat.commonFormat,
      format.isInterleaved == expectedFormat.isInterleaved
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
    while audio.framePosition < audio.length {
      let remaining = audio.length - audio.framePosition
      let capacity = AVAudioFrameCount(min(8_192, remaining))
      guard
        capacity > 0,
        let buffer = AVAudioPCMBuffer(
          pcmFormat: format,
          frameCapacity: capacity
        )
      else {
        throw CocoaError(.fileReadCorruptFile)
      }
      try audio.read(into: buffer, frameCount: capacity)
      guard buffer.frameLength > 0 else { break }
      try writer.append(buffer, track: track)
    }
  }

  private static func hasCompleteCaptionFrame(at root: URL) -> Bool {
    let spool = root.appendingPathComponent(
      "caption/live-caption.pcmspool",
      isDirectory: false
    )
    guard
      let bytes = try? spool.resourceValues(
        forKeys: [.fileSizeKey]
      ).fileSize
    else {
      return false
    }
    return bytes >= CaptionPcmSpoolWriter.frameBytes
  }

  private static func captionSpoolMatchesJournal(
    at root: URL,
    document: [String: Any]
  ) -> Bool {
    guard
      let spool = document["spool"] as? [String: Any],
      spool["complete"] as? Bool == true,
      spool["disposable"] as? Bool == true,
      spool["formalEligible"] as? Bool == true,
      let expectedBytes = (spool["bytes"] as? NSNumber)?.intValue,
      expectedBytes > 0,
      expectedBytes % CaptionPcmSpoolWriter.frameBytes == 0,
      let expectedHash = spool["sha256"] as? String,
      expectedHash.count == 64
    else {
      return false
    }
    let url = root.appendingPathComponent("caption/live-caption.pcmspool")
    guard
      let pinned = try? readPinnedRegularFile(
        url,
        expectedBytes: Int64(expectedBytes),
        maximumBytes: 4 * 60 * 60 * 16_000 * 2,
        collect: false
      )
    else {
      return false
    }
    return pinned.sha256 == expectedHash
  }

  private static func captionSpoolAuthority(
    at root: URL,
    captureTimelineMs: Int,
    expectedDurationMs: Int,
    gapCount: Int
  ) throws -> [String: Any] {
    let url = root.appendingPathComponent("caption/live-caption.pcmspool")
    let values = try url.resourceValues(forKeys: [.fileSizeKey])
    let bytes = values.fileSize ?? 0
    guard
      bytes > 0,
      bytes <= 4 * 60 * 60 * 16_000 * 2,
      bytes % CaptionPcmSpoolWriter.frameBytes == 0,
      bytes / 32 == ((expectedDurationMs + 99) / 100) * 100
    else {
      throw CaptureFailure("CAPTURE_SPOOL_INVALID", "caption spool is incomplete")
    }
    return [
      "relativePath": "caption/live-caption.pcmspool",
      "format": "s16le",
      "sampleRate": 16_000,
      "channels": 1,
      "frameDurationMs": 100,
      // CAF chunks and the journal remain the recording authority. This
      // derived processing input is disposable and deterministically rebuilt.
      "disposable": true,
      "complete": true,
      "formalEligible": true,
      "bytes": bytes,
      "sha256": try sha256(url),
      "durationMs": bytes / 32,
      "captureTimelineMs": max(0, captureTimelineMs),
      "gapCount": max(0, gapCount),
    ]
  }

  private static func gapCount(_ events: [[String: Any]]) -> Int {
    events.filter {
      ["track_gap", "device_changed", "encoder_failed"].contains(
        $0["kind"] as? String ?? ""
      )
    }.count
  }

  private static func maximumChunkEndMs(_ chunks: [[String: Any]]) -> Int {
    chunks.compactMap { ($0["endMs"] as? NSNumber)?.intValue }.max() ?? 0
  }

  static func clone(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(
      pcmFormat: source.format,
      frameCapacity: source.frameLength
    ) else {
      return nil
    }
    copy.frameLength = source.frameLength
    let sourceBuffers = UnsafeMutableAudioBufferListPointer(
      source.mutableAudioBufferList
    )
    let destinationBuffers = UnsafeMutableAudioBufferListPointer(
      copy.mutableAudioBufferList
    )
    guard sourceBuffers.count == destinationBuffers.count else {
      return nil
    }
    for index in 0..<sourceBuffers.count {
      let sourceBuffer = sourceBuffers[index]
      let byteCount = Int(sourceBuffer.mDataByteSize)
      guard
        let sourceData = sourceBuffer.mData,
        let destinationData = destinationBuffers[index].mData
      else {
        return nil
      }
      memcpy(destinationData, sourceData, byteCount)
      destinationBuffers[index].mDataByteSize = sourceBuffer.mDataByteSize
    }
    return copy
  }

  private static func formatName(_ format: AVAudioFormat) -> String {
    let interleaving = format.isInterleaved ? "interleaved" : "planar"
    return "\(format.commonFormat)-\(interleaving)"
  }

  private static func createPrivateDirectory(_ url: URL) throws {
    var info = stat()
    if lstat(url.path, &info) == 0 {
      guard (info.st_mode & S_IFMT) == S_IFDIR else {
        throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture directory is unsafe")
      }
      return
    }
    guard errno == ENOENT else { throw CocoaError(.fileWriteUnknown) }
    let parent = url.deletingLastPathComponent()
    guard lstat(parent.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture directory parent is unsafe")
    }
    guard mkdir(url.path, 0o700) == 0 else { throw CocoaError(.fileWriteUnknown) }
    try synchronizeDirectory(parent)
  }

  static func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func readPinnedRegularFile(
    _ url: URL,
    expectedBytes: Int64?,
    maximumBytes: Int64,
    collect: Bool
  ) throws -> (sha256: String, data: Data?) {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CocoaError(.fileReadNoSuchFile) }
    defer { close(descriptor) }
    var before = stat()
    guard fstat(descriptor, &before) == 0,
      (before.st_mode & S_IFMT) == S_IFREG,
      before.st_nlink == 1,
      before.st_size >= 0,
      before.st_size <= maximumBytes,
      expectedBytes == nil || before.st_size == expectedBytes,
      before.st_size == 0 || Int64(before.st_blocks) * 512 >= before.st_size
    else { throw CocoaError(.fileReadCorruptFile) }
    var hasher = SHA256()
    var collected = Data()
    if collect { collected.reserveCapacity(Int(before.st_size)) }
    var consumed: Int64 = 0
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    while consumed < before.st_size {
      let count = min(buffer.count, Int(before.st_size - consumed))
      let bytesRead = Darwin.read(descriptor, &buffer, count)
      guard bytesRead > 0 else { throw CocoaError(.fileReadCorruptFile) }
      let bytes = Data(buffer[0..<bytesRead])
      hasher.update(data: bytes)
      if collect { collected.append(bytes) }
      consumed += Int64(bytesRead)
    }
    var after = stat()
    var current = stat()
    guard fstat(descriptor, &after) == 0,
      lstat(url.path, &current) == 0,
      consumed == before.st_size,
      after.st_dev == before.st_dev,
      after.st_ino == before.st_ino,
      after.st_size == before.st_size,
      after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec,
      after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
      current.st_dev == before.st_dev,
      current.st_ino == before.st_ino,
      (current.st_mode & S_IFMT) == S_IFREG
    else { throw CocoaError(.fileReadCorruptFile) }
    return (
      hasher.finalize().map { String(format: "%02x", $0) }.joined(),
      collect ? collected : nil
    )
  }

  private static func safeRegularFile(
    _ url: URL,
    expectedBytes: Int64?
  ) -> Bool {
    var info = stat()
    guard lstat(url.path, &info) == 0,
      (info.st_mode & S_IFMT) == S_IFREG,
      info.st_nlink == 1,
      info.st_size >= 0
    else { return false }
    if let expectedBytes, info.st_size != expectedBytes { return false }
    if info.st_size > 0, Int64(info.st_blocks) * 512 < info.st_size {
      return false
    }
    return true
  }

  private static func directoryIdentityMatches(_ url: URL, _ pinned: stat) -> Bool {
    var current = stat()
    return lstat(url.path, &current) == 0 &&
      (current.st_mode & S_IFMT) == S_IFDIR &&
      current.st_dev == pinned.st_dev && current.st_ino == pinned.st_ino
  }

  static func synchronize(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    if fcntl(handle.fileDescriptor, F_FULLFSYNC) != 0 {
      guard fsync(handle.fileDescriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    try handle.close()
#if DEBUG
    durabilityObserver?("file:\(url.lastPathComponent)")
#endif
  }

  static func synchronizeDirectory(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { close(descriptor) }
    if fcntl(descriptor, F_FULLFSYNC) != 0, fsync(descriptor) != 0 {
      throw CocoaError(.fileWriteUnknown)
    }
#if DEBUG
    durabilityObserver?("directory:\(url.lastPathComponent)")
#endif
  }

  private static func atomicWrite(
    _ data: Data,
    fileName: String,
    directoryDescriptor: Int32
  ) throws {
    let temporaryName = ".capture-write-\(UUID().uuidString)"
    let descriptor = openat(
      directoryDescriptor,
      temporaryName,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      0o600
    )
    guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    var committed = false
    defer {
      close(descriptor)
      if !committed { unlinkat(directoryDescriptor, temporaryName, 0) }
    }
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var offset = 0
      while offset < raw.count {
        let count = Darwin.write(
          descriptor,
          base.advanced(by: offset),
          raw.count - offset
        )
        guard count > 0 else { throw CocoaError(.fileWriteUnknown) }
        offset += count
      }
    }
    if fcntl(descriptor, F_FULLFSYNC) != 0, fsync(descriptor) != 0 {
      throw CocoaError(.fileWriteUnknown)
    }
#if DEBUG
    durabilityObserver?("file:\(fileName)")
#endif
    guard renameat(
      directoryDescriptor,
      temporaryName,
      directoryDescriptor,
      fileName
    ) == 0 else { throw CocoaError(.fileWriteUnknown) }
    committed = true
    if fcntl(directoryDescriptor, F_FULLFSYNC) != 0,
      fsync(directoryDescriptor) != 0
    {
      throw CocoaError(.fileWriteUnknown)
    }
#if DEBUG
    durabilityObserver?("directory:root")
#endif
  }

  private func validateRootIdentity() throws {
    var current = stat()
    guard lstat(root.path, &current) == 0,
      (current.st_mode & S_IFMT) == S_IFDIR,
      UInt64(current.st_dev) == rootIdentity.0,
      UInt64(current.st_ino) == rootIdentity.1
    else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "capture session root identity changed")
    }
  }

  private static func wallClockMs() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
  }
}

private final class CaptureTrackChunkWriter {
  private let kind: NativeCaptureTrack
  private let directory: URL
  private let relativeDirectory: String
  private let format: AVAudioFormat
  private let targetFrames: AVAudioFramePosition
  private var sequence = 0
  private var totalFrames: AVAudioFramePosition = 0
  private var currentFrames: AVAudioFramePosition = 0
  private var file: AVAudioFile?
  private var partialURL: URL?
  private var partialName: String?
  private let directoryDescriptor: Int32
  private let directoryIdentity: (UInt64, UInt64)

  var committedFrames: AVAudioFramePosition {
    totalFrames
  }

  init(
    kind: NativeCaptureTrack,
    directory: URL,
    relativeDirectory: String,
    format: AVAudioFormat,
    chunkDurationMs: Int
  ) throws {
    self.kind = kind
    self.directory = directory
    self.relativeDirectory = relativeDirectory
    self.format = format
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CaptureFailure("HELPER_CAPABILITY_DENIED", "track directory is unsafe") }
    var directoryInfo = stat()
    guard fstat(descriptor, &directoryInfo) == 0 else {
      close(descriptor)
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "track directory is unavailable")
    }
    directoryDescriptor = descriptor
    directoryIdentity = (UInt64(directoryInfo.st_dev), UInt64(directoryInfo.st_ino))
    targetFrames = AVAudioFramePosition(
      format.sampleRate * Double(chunkDurationMs) / 1000
    )
  }

  deinit { close(directoryDescriptor) }

  func append(_ buffer: AVAudioPCMBuffer) throws -> [String: Any]? {
    if file == nil {
      try openNextFile()
    }
    try file?.write(from: buffer)
    currentFrames += AVAudioFramePosition(buffer.frameLength)
    guard currentFrames >= targetFrames else { return nil }
    return try finalizeOpenChunk()
  }

  func finalizeOpenChunk() throws -> [String: Any]? {
    guard currentFrames > 0, let partialURL, let partialName else { return nil }
    file = nil
    try validateDirectoryIdentity()
    try CaptureChunkJournal.synchronize(partialURL)
    let finalName = String(format: "chunk-%06d.caf", sequence)
    let finalURL = directory.appendingPathComponent(finalName)
    var existing = stat()
    if fstatat(directoryDescriptor, finalName, &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "chunk destination already exists")
    }
    guard renameat(directoryDescriptor, partialName, directoryDescriptor, finalName) == 0 else {
      throw CocoaError(.fileWriteUnknown)
    }
    try CaptureChunkJournal.synchronizeDirectory(directory)
    try CaptureChunkJournal.synchronize(finalURL)
    let values = try finalURL.resourceValues(forKeys: [.fileSizeKey])
    let byteCount = values.fileSize ?? 0
    guard byteCount > 0 else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let startMs = Int(Double(totalFrames) * 1000 / format.sampleRate)
    totalFrames += currentFrames
    let endMs = Int(Double(totalFrames) * 1000 / format.sampleRate)
    let record: [String: Any] = [
      "track": kind.rawValue,
      "sequence": sequence,
      "startMs": startMs,
      "endMs": endMs,
      "relativePath": "\(relativeDirectory)/\(finalName)",
      "bytes": byteCount,
      "sha256": try CaptureChunkJournal.sha256(finalURL),
      "finalized": true,
    ]
    sequence += 1
    currentFrames = 0
    self.partialURL = nil
    self.partialName = nil
    return record
  }

  private func openNextFile() throws {
    let partialName = String(
      format: "chunk-%06d.caf.partial",
      sequence
    )
    let nextPartialURL = directory.appendingPathComponent(partialName)
    try validateDirectoryIdentity()
    var existing = stat()
    if fstatat(directoryDescriptor, partialName, &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "chunk staging entry already exists")
    }
    file = try AVAudioFile(
      forWriting: nextPartialURL,
      settings: format.settings,
      commonFormat: format.commonFormat,
      interleaved: format.isInterleaved
    )
    partialURL = nextPartialURL
    self.partialName = partialName
    try validateDirectoryIdentity()
  }

  private func validateDirectoryIdentity() throws {
    var current = stat()
    guard lstat(directory.path, &current) == 0,
      (current.st_mode & S_IFMT) == S_IFDIR,
      UInt64(current.st_dev) == directoryIdentity.0,
      UInt64(current.st_ino) == directoryIdentity.1
    else {
      throw CaptureFailure("HELPER_CAPABILITY_DENIED", "track directory identity changed")
    }
  }
}

/// Writes a disposable 100 ms, 16 kHz mono stream without ever applying
/// backpressure to the two authority-track writers. The fixed-size frames are
/// discoverable from the durable file length, so a reader never consumes a
/// partial trailing frame.
private final class CaptionPcmSpoolWriter {
  private static let sampleRate = 16_000.0
  private static let frameSamples = 1_600
  static let frameBytes = frameSamples * MemoryLayout<Int16>.size
  private let file: FileHandle
  private let activeTracks: [NativeCaptureTrack]
  private var converters = [NativeCaptureTrack: AVAudioConverter]()
  private var pending = [NativeCaptureTrack: [Float]]()
  private var consumed = [NativeCaptureTrack: Int]()
  private var closed = false

  init(
    url: URL,
    formats: [(NativeCaptureTrack, AVAudioFormat)]
  ) throws {
    guard !formats.isEmpty else {
      throw CocoaError(.fileWriteUnknown)
    }
    file = try FileHandle(forWritingTo: url)
    activeTracks = formats.map { $0.0 }
    try file.seekToEnd()
    for (kind, format) in formats {
      guard
        let output = AVAudioFormat(
          standardFormatWithSampleRate: Self.sampleRate,
          channels: 1
        ),
        let converter = AVAudioConverter(from: format, to: output)
      else {
        throw CocoaError(.fileWriteUnknown)
      }
      converters[kind] = converter
      pending[kind] = []
      consumed[kind] = 0
    }
  }

  deinit {
    try? file.close()
  }

  func append(_ buffer: AVAudioPCMBuffer, track: NativeCaptureTrack) throws {
    guard !closed, let converter = converters[track] else { return }
    let ratio = Self.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(
      max(1, Int(ceil(Double(buffer.frameLength) * ratio)) + 32)
    )
    guard
      let outputFormat = AVAudioFormat(
        standardFormatWithSampleRate: Self.sampleRate,
        channels: 1
      ),
      let output = AVAudioPCMBuffer(
        pcmFormat: outputFormat,
        frameCapacity: capacity
      )
    else {
      throw CocoaError(.fileWriteUnknown)
    }
    var delivered = false
    var conversionError: NSError?
    let status = converter.convert(
      to: output,
      error: &conversionError
    ) { _, inputStatus in
      if delivered {
        inputStatus.pointee = .noDataNow
        return nil
      }
      delivered = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error {
      throw conversionError ?? CocoaError(.fileWriteUnknown)
    }
    guard
      output.frameLength > 0,
      let channel = output.floatChannelData?[0]
    else {
      return
    }
    pending[track, default: []].append(
      contentsOf: UnsafeBufferPointer(
        start: channel,
        count: Int(output.frameLength)
      )
    )
    try writeCompleteMixedFrames()
  }

  func finalize() throws {
    guard !closed else { return }
    let tail = activeTracks.map { remaining($0) }.max() ?? 0
    if tail > 0 {
      let target = Int(
        ceil(Double(tail) / Double(Self.frameSamples))
      ) * Self.frameSamples
      for track in activeTracks {
        let available = remaining(track)
        if available < target {
          pending[track, default: []].append(
            contentsOf: repeatElement(0, count: target - available)
          )
        }
      }
      try writeCompleteMixedFrames()
    }
    try file.synchronize()
    try file.close()
    closed = true
  }

  private func writeCompleteMixedFrames() throws {
    while activeTracks.allSatisfy({
      remaining($0) >= Self.frameSamples
    }) {
      var data = Data(capacity: Self.frameSamples * 2)
      for index in 0..<Self.frameSamples {
        let sum = activeTracks.reduce(Float(0)) { value, track in
          let start = consumed[track, default: 0]
          return value + pending[track, default: []][start + index]
        }
        let mixed = max(-1, min(1, sum / Float(activeTracks.count)))
        var sample = Int16((mixed * 32_767).rounded()).littleEndian
        withUnsafeBytes(of: &sample) { bytes in
          data.append(contentsOf: bytes)
        }
      }
      try file.write(contentsOf: data)
      for track in activeTracks {
        consumed[track, default: 0] += Self.frameSamples
        compactIfNeeded(track)
      }
    }
  }

  private func remaining(_ track: NativeCaptureTrack) -> Int {
    pending[track, default: []].count - consumed[track, default: 0]
  }

  private func compactIfNeeded(_ track: NativeCaptureTrack) {
    let offset = consumed[track, default: 0]
    guard offset >= 16_000 else { return }
    pending[track, default: []].removeFirst(offset)
    consumed[track] = 0
  }
}
