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
  private let queue = DispatchQueue(
    label: "com.voice2text.desktop.capture.chunks",
    qos: .utility
  )
  private let root: URL
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
  private let failureHandler: ((NativeCaptureTrack, String) -> Void)?

  init(
    root: URL,
    sessionID: String,
    systemFormat: AVAudioFormat?,
    microphoneFormat: AVAudioFormat,
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
    try Self.createPrivateDirectory(
      root.appendingPathComponent("caption", isDirectory: true)
    )
    let spool = root.appendingPathComponent(
      "caption/live-caption.pcmspool",
      isDirectory: false
    )
    if !FileManager.default.fileExists(atPath: spool.path) {
      FileManager.default.createFile(
        atPath: spool.path,
        contents: Data(),
        attributes: [.posixPermissions: 0o600]
      )
    }
    var formats = [(NativeCaptureTrack, AVAudioFormat)]()
    if let systemFormat {
      formats.append((.systemAudio, systemFormat))
    }
    formats.append((.microphone, microphoneFormat))
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
      do {
        try? self.captionSpool?.append(buffer, track: kind)
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
      try captionSpool?.finalize()
      captionSpool = nil
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
      "spool": [
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
    try data.write(to: journalURL, options: [.atomic])
    try Self.synchronize(journalURL)
  }

  static func recoverSession(at root: URL) -> CaptureRecoveryReport? {
    let started = DispatchTime.now()
    let journalURL = root.appendingPathComponent("journal.json")
    guard
      let data = try? Data(contentsOf: journalURL),
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
      referenced.insert(relativePath)
      let file = root.appendingPathComponent(relativePath).standardizedFileURL
      guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
        let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
        Int64(size) == expectedBytes,
        (try? sha256(file)) == expectedHash
      else {
        invalidFinalized += 1
        continue
      }
      validatedChunks.append(chunk)
      lastSafeChunkMs = max(lastSafeChunkMs, endMs)
    }

    let quarantine = root.appendingPathComponent(
      "quarantine",
      isDirectory: true
    )
    try? createPrivateDirectory(quarantine)
    var quarantined = 0
    for kind in NativeCaptureTrack.allCases {
      let directory = root.appendingPathComponent(
        kind.directoryName,
        isDirectory: true
      )
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
        if FileManager.default.fileExists(atPath: destination.path) {
          try? FileManager.default.removeItem(at: destination)
        }
        if (try? FileManager.default.moveItem(
          at: tail,
          to: destination
        )) != nil {
          quarantined += 1
        }
      }
    }

    let captionSpoolRebuilt = rebuildCaptionSpoolIfNeeded(
      at: root,
      validatedChunks: validatedChunks
    )
    let captionSpoolUsable = hasCompleteCaptionFrame(at: root)

    if document["state"] as? String != "completed" {
      let previousState = document["state"] as? String
      let recordedTimelineMs =
        (document["captureTimelineMs"] as? NSNumber)?.intValue ?? 0
      document["captureTimelineMs"] = max(
        recordedTimelineMs,
        lastSafeChunkMs
      )
      document["state"] = invalidFinalized > 0 ||
        previousState == "partial_capture" ||
        previousState == "failed"
        ? "partial_capture"
        : "recoverable"
      document["updatedAtMs"] = wallClockMs()
      if let updated = try? JSONSerialization.data(
        withJSONObject: document,
        options: [.prettyPrinted, .sortedKeys]
      ) {
        try? updated.write(to: journalURL, options: [.atomic])
        try? synchronize(journalURL)
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
      "finalizedChunkCount": chunks.count,
      "eventCount": (document["events"] as? [Any])?.count ?? 0,
    ]
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
    guard !hasCompleteCaptionFrame(at: root) else { return false }

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
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
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

  static func synchronize(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    try handle.synchronize()
    try handle.close()
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
    targetFrames = AVAudioFramePosition(
      format.sampleRate * Double(chunkDurationMs) / 1000
    )
  }

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
    guard currentFrames > 0, let partialURL else { return nil }
    file = nil
    try CaptureChunkJournal.synchronize(partialURL)
    let finalName = String(format: "chunk-%06d.caf", sequence)
    let finalURL = directory.appendingPathComponent(finalName)
    if FileManager.default.fileExists(atPath: finalURL.path) {
      try FileManager.default.removeItem(at: finalURL)
    }
    try FileManager.default.moveItem(at: partialURL, to: finalURL)
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
    return record
  }

  private func openNextFile() throws {
    let partialName = String(
      format: "chunk-%06d.caf.partial",
      sequence
    )
    let nextPartialURL = directory.appendingPathComponent(partialName)
    if FileManager.default.fileExists(atPath: nextPartialURL.path) {
      try FileManager.default.removeItem(at: nextPartialURL)
    }
    file = try AVAudioFile(
      forWriting: nextPartialURL,
      settings: format.settings,
      commonFormat: format.commonFormat,
      interleaved: format.isInterleaved
    )
    partialURL = nextPartialURL
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
