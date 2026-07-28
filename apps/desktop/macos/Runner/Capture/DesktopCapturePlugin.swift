import AVFoundation
import AppKit
import FlutterMacOS
import Foundation

final class DesktopCapturePlugin: NSObject, FlutterStreamHandler {
  private let channel: FlutterMethodChannel
  private let events: FlutterEventChannel
  private let queue = DispatchQueue(
    label: "com.voice2text.desktop.capture",
    qos: .userInitiated
  )
  private var eventSink: FlutterEventSink?
  private var systemCapture: Any?
  private var microphoneCapture: MicrophoneCapture?
  private var captureJournal: CaptureChunkJournal?
  private var recordingMenuBarController: RecordingMenuBarController?
  private var systemWillSleepObserver: NSObjectProtocol?
  private var systemDidWakeObserver: NSObjectProtocol?
#if DEBUG
  private var developmentLastFrameAccounting: [String: Any]?
#endif
  private var diskMonitor: CaptureDiskMonitor?
  private var meterTimer: DispatchSourceTimer?
  private var sessionID: String?
  private var state = "idle"
  private var startedAt = DispatchTime.now()
  private var accumulatedMs = 0
  private var captureMode = "dual_track"
  private var partialCapture = false
  private var systemHealthy = false
  private var microphoneHealthy = false
  private var lastResults = [String: [String: Any]]()
  private var interruptionReason: String?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(
      name: "com.voice2text.desktop/capture",
      binaryMessenger: messenger
    )
    events = FlutterEventChannel(
      name: "com.voice2text.desktop/capture_events",
      binaryMessenger: messenger
    )
    super.init()
    let menuBarController = RecordingMenuBarController()
    menuBarController.onAction = { [weak self] action in
      self?.channel.invokeMethod(
        "menuAction",
        arguments: ["action": action]
      )
    }
    recordingMenuBarController = menuBarController
    let workspaceNotifications = NSWorkspace.shared.notificationCenter
    systemWillSleepObserver = workspaceNotifications.addObserver(
      forName: NSWorkspace.willSleepNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        self?.handleSystemWillSleep()
      }
    }
    systemDidWakeObserver = workspaceNotifications.addObserver(
      forName: NSWorkspace.didWakeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        self?.handleSystemDidWake()
      }
    }
    channel.setMethodCallHandler(handle)
    events.setStreamHandler(self)
  }

#if DEBUG
  func runDevelopmentCrashRecovery() {
    queue.async {
      let environment = ProcessInfo.processInfo.environment
      guard
        let stage = environment["VOICE2TEXT_U12_CRASH_STAGE"],
        ["during_write", "during_finalize", "after_journal"].contains(stage),
        let runID = environment["VOICE2TEXT_U12_CRASH_RUN_ID"],
        runID.range(
          of: "^[a-zA-Z0-9-]{8,64}$",
          options: .regularExpression
        ) != nil
      else {
        return
      }
      let support = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      )[0]
      let root = support
        .appendingPathComponent(
          "voice2text-u12-crash-probes",
          isDirectory: true
        )
        .appendingPathComponent(
          "session-u12-\(stage.replacingOccurrences(of: "_", with: "-"))-\(runID)",
          isDirectory: true
        )
      let output = support.appendingPathComponent(
        "voice2text-u12-crash-recovery-\(stage)-\(runID).json"
      )
      let first = CaptureChunkJournal.recoverSession(at: root)
      let second = CaptureChunkJournal.recoverSession(at: root)
      let quarantine = first?.quarantinedTailChunks ?? -1
      let passed = first != nil &&
        second != nil &&
        first?.invalidFinalizedChunks == 0 &&
        quarantine >= 1 &&
        quarantine <= 2 &&
        second?.invalidFinalizedChunks == 0 &&
        second?.quarantinedTailChunks == 0
      self.finishDevelopmentSmoke(
        [
          "schemaVersion": 1,
          "status": passed ? "PASS" : "FAIL",
          "stage": stage,
          "runId": runID,
          "sessionRoot": root.path,
          "firstRecoveryMs": first?.recoveryMs ?? -1,
          "secondRecoveryMs": second?.recoveryMs ?? -1,
          "quarantinedTailChunks": quarantine,
          "invalidFinalizedChunks":
            first?.invalidFinalizedChunks ?? -1,
          "captionSpoolRebuilt":
            first?.captionSpoolRebuilt ?? false,
          "captionSpoolUsable":
            first?.captionSpoolUsable ?? false,
          "finalizedChunkCount":
            first?.snapshot["finalizedChunkCount"] as? Int ?? -1,
          "idempotent": second?.quarantinedTailChunks == 0,
        ],
        output: output
      )
    }
  }

  func runDevelopmentDurabilityProbe() {
    let support = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0]
    let output = support.appendingPathComponent(
      "voice2text-u11-capture-durability-probe.json",
      isDirectory: false
    )
    queue.async {
      self.performDevelopmentDurabilityProbe(output: output)
    }
  }

  func runDevelopmentSmoke() {
    let output = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0].appendingPathComponent(
      "voice2text-u11-capture-smoke.json",
      isDirectory: false
    )
    let begin = {
      self.queue.asyncAfter(deadline: .now() + 1) {
        self.performDevelopmentSmoke(output: output)
      }
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
      MicrophoneCapture.requestPermission { granted in
        guard granted else {
          self.finishDevelopmentSmoke(
            [
              "schemaVersion": 1,
              "status": "FAIL",
              "error": "microphone_permission_denied",
              "durationLimitSeconds": 10,
            ],
            output: output
          )
          return
        }
        begin()
      }
    } else {
      begin()
    }
  }

  private func performDevelopmentSmoke(output: URL) {
    var document: [String: Any] = [
      "schemaVersion": 1,
      "startedAtUtc": ISO8601DateFormatter().string(from: Date()),
      "durationLimitSeconds": 10,
    ]
    guard #available(macOS 14.2, *) else {
      document["status"] = "FAIL"
      document["error"] = "macos_14_2_required"
      finishDevelopmentSmoke(document, output: output)
      return
    }

    let systemCapture = CoreAudioProcessTapCapture()
    let microphoneCapture = MicrophoneCapture()
    do {
      try systemCapture.start()
      do {
        try microphoneCapture.start()
      } catch {
        systemCapture.teardown()
        throw error
      }

      Thread.sleep(forTimeInterval: 1.5)
      systemCapture.pause()
      microphoneCapture.pause()
      Thread.sleep(forTimeInterval: 0.25)
      try systemCapture.start()
      try microphoneCapture.start()
      Thread.sleep(forTimeInterval: 1.5)

      document["status"] = "PASS"
      document["systemAudio"] = [
        "observedFrames": systemCapture.observedFrames,
        "sampleRate": systemCapture.sampleRate,
        "channelCount": systemCapture.channelCount,
        "startAttempts": systemCapture.startAttempts,
      ]
      document["microphone"] = [
        "observedFrames": microphoneCapture.observedFrames,
        "sampleRate": microphoneCapture.sampleRate,
        "channelCount": microphoneCapture.channelCount,
      ]
      document["pauseMilliseconds"] = 250
    } catch {
      document["status"] = "FAIL"
      document["error"] = String(describing: error)
    }
    systemCapture.teardown()
    microphoneCapture.teardown()
    finishDevelopmentSmoke(document, output: output)
  }

  private func finishDevelopmentSmoke(
    _ document: [String: Any],
    output: URL
  ) {
    var value = document
    value["finishedAtUtc"] = ISO8601DateFormatter().string(from: Date())
    do {
      let data = try JSONSerialization.data(
        withJSONObject: value,
        options: [.prettyPrinted, .sortedKeys]
      )
      try data.write(to: output, options: [.atomic])
      NSLog("Voice2Text U11 capture smoke output: %@", output.path)
    } catch {
      NSLog("Voice2Text U11 capture smoke output failed: %@", "\(error)")
    }
    DispatchQueue.main.async {
      NSApplication.shared.terminate(nil)
    }
  }

  private func performDevelopmentDurabilityProbe(output: URL) {
    let configuredSeconds = Int(
      ProcessInfo.processInfo.environment[
        "VOICE2TEXT_U11_PROBE_SECONDS"
      ] ?? ""
    ) ?? 1200
    let durationSeconds = min(1800, max(10, configuredSeconds))
    let support = output.deletingLastPathComponent()
    let environment = ProcessInfo.processInfo.environment
    let crashStage = environment["VOICE2TEXT_U12_CRASH_STAGE"]
    let crashRunID = environment["VOICE2TEXT_U12_CRASH_RUN_ID"]
    let validCrash = crashStage.map {
      ["during_write", "during_finalize", "after_journal"].contains($0)
    } == true && crashRunID?.range(
      of: "^[a-zA-Z0-9-]{8,64}$",
      options: .regularExpression
    ) != nil
    let probeRoot: URL
    if validCrash, let crashStage, let crashRunID {
      probeRoot = support
        .appendingPathComponent(
          "voice2text-u12-crash-probes",
          isDirectory: true
        )
        .appendingPathComponent(
          "session-u12-\(crashStage.replacingOccurrences(of: "_", with: "-"))-\(crashRunID)",
          isDirectory: true
        )
    } else {
      probeRoot = support
        .appendingPathComponent("voice2text-u11-probes", isDirectory: true)
        .appendingPathComponent(
          "session-u11-\(UUID().uuidString.lowercased())",
          isDirectory: true
        )
    }
    let progress = support.appendingPathComponent(
      "voice2text-u11-capture-durability-progress.json",
      isDirectory: false
    )
    var document: [String: Any] = [
      "schemaVersion": 1,
      "startedAtUtc": ISO8601DateFormatter().string(from: Date()),
      "durationLimitSeconds": 1800,
      "requestedDurationSeconds": durationSeconds,
      "sessionRoot": probeRoot.path,
    ]
    guard #available(macOS 14.2, *) else {
      document["status"] = "FAIL"
      document["error"] = "macos_14_2_required"
      finishDevelopmentSmoke(document, output: output)
      return
    }

    let systemCapture = CoreAudioProcessTapCapture()
    let microphoneCapture = MicrophoneCapture()
    do {
      try systemCapture.start()
      do {
        try microphoneCapture.start()
      } catch {
        systemCapture.teardown()
        throw error
      }
      guard
        let systemFormat = systemCapture.format,
        let microphoneFormat = microphoneCapture.format
      else {
        throw DesktopMicrophoneCaptureError.invalidFormat
      }
      let journal = try CaptureChunkJournal(
        root: probeRoot,
        sessionID: probeRoot.lastPathComponent,
        systemFormat: systemFormat,
        microphoneFormat: microphoneFormat
      )
      try journal.beginRecording()
      systemCapture.setBufferHandler { [weak journal] buffer in
        journal?.append(buffer, to: .systemAudio)
      }
      microphoneCapture.setBufferHandler { [weak journal] buffer in
        journal?.append(buffer, to: .microphone)
      }

      let started = DispatchTime.now()
      var pausedMs = 0
      var pauseExercised = false
      var lastProgressSecond = -1
      while true {
        let elapsedNanos = DispatchTime.now().uptimeNanoseconds -
          started.uptimeNanoseconds
        let elapsedSeconds = Int(elapsedNanos / 1_000_000_000)
        if elapsedSeconds >= durationSeconds {
          break
        }
        if !pauseExercised, elapsedSeconds >= durationSeconds / 2 {
          systemCapture.pause()
          microphoneCapture.pause()
          try journal.pause(at: elapsedSeconds * 1000 - pausedMs)
          Thread.sleep(forTimeInterval: 0.25)
          pausedMs += 250
          try systemCapture.start()
          try microphoneCapture.start()
          try journal.resume(at: elapsedSeconds * 1000 - pausedMs)
          pauseExercised = true
        }
        if elapsedSeconds == 0 ||
          (elapsedSeconds % 30 == 0 && elapsedSeconds != lastProgressSecond)
        {
          lastProgressSecond = elapsedSeconds
          let snapshot = journal.snapshot(
            systemHealthy: true,
            microphoneHealthy: true,
            partial: false
          )
          try writeDevelopmentDocument(
            [
              "schemaVersion": 1,
              "status": "RUNNING",
              "elapsedSeconds": elapsedSeconds,
              "requestedDurationSeconds": durationSeconds,
              "finalizedChunkCount":
                snapshot["finalizedChunkCount"] as? Int ?? 0,
            ],
            output: progress
          )
        }
        Thread.sleep(forTimeInterval: 0.1)
      }

      systemCapture.teardown()
      microphoneCapture.teardown()
      let captureTimelineMs = durationSeconds * 1000 - pausedMs
      try journal.finalize(at: captureTimelineMs, partial: false)
      let chunks = journal.finalizedChunks()
      let systemChunks = chunks.filter {
        $0["track"] as? String == NativeCaptureTrack.systemAudio.rawValue
      }
      let microphoneChunks = chunks.filter {
        $0["track"] as? String == NativeCaptureTrack.microphone.rawValue
      }
      let completedRecovery = CaptureChunkJournal.recoverSession(at: probeRoot)
      let faultResults = try runDevelopmentRecoveryFixtures(
        sourceRoot: probeRoot,
        chunks: chunks
      )
      let allRecoveryMs = faultResults.compactMap {
        ($0["firstRecoveryMs"] as? NSNumber)?.intValue
      } + [completedRecovery?.recoveryMs ?? 0]
      let recoveryMaximumMs = allRecoveryMs.max() ?? 0
      let chunksValid = !systemChunks.isEmpty &&
        !microphoneChunks.isEmpty &&
        completedRecovery?.invalidFinalizedChunks == 0
      let recoveryValid = faultResults.allSatisfy {
        $0["passed"] as? Bool == true
      }
      let admissible = durationSeconds >= 1200
      document["status"] = chunksValid && recoveryValid
        ? (admissible ? "PASS" : "PASS_NON_ADMISSIBLE_SHORT")
        : "FAIL"
      document["finishedAtUtc"] = ISO8601DateFormatter().string(from: Date())
      document["admissibleDuration"] = admissible
      document["captureTimelineMs"] = captureTimelineMs
      document["pauseMilliseconds"] = pausedMs
      document["systemAudio"] = [
        "sampleRate": systemCapture.sampleRate,
        "channelCount": systemCapture.channelCount,
        "observedFrames": systemCapture.observedFrames,
        "finalizedChunkCount": systemChunks.count,
        "chunkDurationsMs": chunkDurations(systemChunks),
      ]
      document["microphone"] = [
        "sampleRate": microphoneCapture.sampleRate,
        "channelCount": microphoneCapture.channelCount,
        "observedFrames": microphoneCapture.observedFrames,
        "finalizedChunkCount": microphoneChunks.count,
        "chunkDurationsMs": chunkDurations(microphoneChunks),
      ]
      document["storageBytes"] = directoryBytes(probeRoot)
      document["completedRecovery"] = [
        "recoveryMs": completedRecovery?.recoveryMs ?? -1,
        "invalidFinalizedChunks":
          completedRecovery?.invalidFinalizedChunks ?? -1,
        "quarantinedTailChunks":
          completedRecovery?.quarantinedTailChunks ?? -1,
      ]
      document["faultInjection"] = faultResults
      document["maximumRecoveryMs"] = recoveryMaximumMs
      document["maximumTailChunksQuarantinedPerTrack"] = 1
      document["decision"] = [
        "chunksValid": chunksValid,
        "recoveryValid": recoveryValid,
        "withinThirtyMinuteLimit": durationSeconds <= 1800,
        "withinThirtySecondRecoveryLimit": recoveryMaximumMs <= 30000,
      ]
    } catch {
      systemCapture.teardown()
      microphoneCapture.teardown()
      document["status"] = "FAIL"
      document["finishedAtUtc"] = ISO8601DateFormatter().string(from: Date())
      document["error"] = String(describing: error)
    }
    try? writeDevelopmentDocument(document, output: output)
    try? FileManager.default.removeItem(at: progress)
    DispatchQueue.main.async {
      NSApplication.shared.terminate(nil)
    }
  }

  private func runDevelopmentRecoveryFixtures(
    sourceRoot: URL,
    chunks: [[String: Any]]
  ) throws -> [[String: Any]] {
    let stages = ["during_write", "during_finalize", "after_journal"]
    let sourceJournal = sourceRoot.appendingPathComponent("journal.json")
    let sourceData = try Data(contentsOf: sourceJournal)
    guard
      let sourceDocument = try JSONSerialization.jsonObject(with: sourceData)
        as? [String: Any]
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let firstChunks = NativeCaptureTrack.allCases.compactMap { kind in
      chunks.first {
        $0["track"] as? String == kind.rawValue
      }
    }
    guard firstChunks.count == NativeCaptureTrack.allCases.count else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let faultRoot = sourceRoot.appendingPathComponent(
      "recovery-fixtures",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: faultRoot,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )

    return try stages.map { stage in
      let fixture = faultRoot.appendingPathComponent(
        "session-u11-\(stage.replacingOccurrences(of: "_", with: "-"))-fixture",
        isDirectory: true
      )
      for kind in NativeCaptureTrack.allCases {
        try FileManager.default.createDirectory(
          at: fixture.appendingPathComponent(
            kind.directoryName,
            isDirectory: true
          ),
          withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700]
        )
      }
      var document = sourceDocument
      document["sessionId"] = fixture.lastPathComponent
      document["state"] = "recording"
      document["chunks"] = firstChunks
      document["recordingId"] = NSNull()
      document["recordingSha256"] = NSNull()
      for chunk in firstChunks {
        guard let relativePath = chunk["relativePath"] as? String else {
          throw CocoaError(.fileReadCorruptFile)
        }
        let destination = fixture.appendingPathComponent(relativePath)
        try FileManager.default.copyItem(
          at: sourceRoot.appendingPathComponent(relativePath),
          to: destination
        )
      }
      if stage == "during_write" {
        for kind in NativeCaptureTrack.allCases {
          let tail = fixture
            .appendingPathComponent(kind.directoryName, isDirectory: true)
            .appendingPathComponent("chunk-999999.caf.partial")
          try Data(repeating: 0x5a, count: 4096).write(to: tail)
        }
      } else if stage == "during_finalize" {
        for kind in NativeCaptureTrack.allCases {
          guard
            let sourceChunk = firstChunks.first(where: {
              $0["track"] as? String == kind.rawValue
            }),
            let relativePath = sourceChunk["relativePath"] as? String
          else {
            throw CocoaError(.fileReadCorruptFile)
          }
          let tail = fixture
            .appendingPathComponent(kind.directoryName, isDirectory: true)
            .appendingPathComponent("chunk-999999.caf")
          try FileManager.default.copyItem(
            at: sourceRoot.appendingPathComponent(relativePath),
            to: tail
          )
        }
      }
      let journal = fixture.appendingPathComponent("journal.json")
      try JSONSerialization.data(
        withJSONObject: document,
        options: [.prettyPrinted, .sortedKeys]
      ).write(to: journal, options: [.atomic])
      try CaptureChunkJournal.synchronize(journal)
      guard
        let first = CaptureChunkJournal.recoverSession(at: fixture),
        let second = CaptureChunkJournal.recoverSession(at: fixture)
      else {
        throw CocoaError(.fileReadCorruptFile)
      }
      let expectedQuarantine = stage == "after_journal" ? 0 : 2
      let passed = first.invalidFinalizedChunks == 0 &&
        first.quarantinedTailChunks == expectedQuarantine &&
        first.captionSpoolRebuilt &&
        first.captionSpoolUsable &&
        second.invalidFinalizedChunks == 0 &&
        !second.captionSpoolRebuilt &&
        second.captionSpoolUsable &&
        second.quarantinedTailChunks == 0 &&
        second.snapshot["finalizedChunkCount"] as? Int == firstChunks.count
      return [
        "stage": stage,
        "passed": passed,
        "firstRecoveryMs": first.recoveryMs,
        "secondRecoveryMs": second.recoveryMs,
        "quarantinedTailChunks": first.quarantinedTailChunks,
        "quarantinedTailChunksPerTrack":
          expectedQuarantine == 0 ? 0 : 1,
        "invalidFinalizedChunks": first.invalidFinalizedChunks,
        "captionSpoolRebuilt": first.captionSpoolRebuilt,
        "captionSpoolUsable": first.captionSpoolUsable,
        "idempotent": second.quarantinedTailChunks == 0,
      ]
    }
  }

  private func chunkDurations(_ chunks: [[String: Any]]) -> [Int] {
    chunks.compactMap { chunk in
      guard
        let start = (chunk["startMs"] as? NSNumber)?.intValue,
        let end = (chunk["endMs"] as? NSNumber)?.intValue
      else {
        return nil
      }
      return max(0, end - start)
    }
  }

  private func directoryBytes(_ root: URL) -> Int64 {
    guard let enumerator = FileManager.default.enumerator(
      at: root,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles]
    ) else {
      return 0
    }
    var total: Int64 = 0
    for case let file as URL in enumerator {
      let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize
      total += Int64(size ?? 0)
    }
    return total
  }

  private func writeDevelopmentDocument(
    _ document: [String: Any],
    output: URL
  ) throws {
    let data = try JSONSerialization.data(
      withJSONObject: document,
      options: [.prettyPrinted, .sortedKeys]
    )
    try data.write(to: output, options: [.atomic])
  }
#endif

  func dispose() {
    queue.sync {
      if ["recording", "paused", "partial_capture"].contains(state) {
        captureJournal?.markRecoverable(at: currentTimelineMs())
      }
      teardown()
      state = "idle"
      sessionID = nil
    }
    channel.setMethodCallHandler(nil)
    events.setStreamHandler(nil)
    recordingMenuBarController?.dispose()
    recordingMenuBarController = nil
    let workspaceNotifications = NSWorkspace.shared.notificationCenter
    if let systemWillSleepObserver {
      workspaceNotifications.removeObserver(systemWillSleepObserver)
      self.systemWillSleepObserver = nil
    }
    if let systemDidWakeObserver {
      workspaceNotifications.removeObserver(systemDidWakeObserver)
      self.systemDidWakeObserver = nil
    }
  }

  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    eventSink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    eventSink = nil
    return nil
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard let arguments = call.arguments as? [String: Any] else {
      result(error("CAPTURE_ARGUMENTS_INVALID", "Capture arguments are invalid"))
      return
    }
#if DEBUG
    if call.method == "developmentInjectFault" {
      queue.async { [weak self] in
        self?.developmentInjectFault(arguments, result: result)
      }
      return
    }
    if call.method == "developmentFrameAccounting" {
      queue.async { [weak self] in
        guard let self,
          let session = bounded(arguments["sessionId"], maximum: 128),
          session == self.developmentLastFrameAccounting?["sessionId"] as? String,
          let accounting = self.developmentLastFrameAccounting
        else {
          self?.finish(
            result,
            self?.error(
              "CAPTURE_ACCOUNTING_UNAVAILABLE",
              "Development frame accounting is unavailable"
            ) ?? FlutterError(
              code: "CAPTURE_ACCOUNTING_UNAVAILABLE",
              message: "Development frame accounting is unavailable",
              details: nil
            )
          )
          return
        }
        self.finish(result, accounting)
      }
      return
    }
#endif
    switch call.method {
    case "preflight":
      runPreflight(arguments, result: result)
    case "start":
      queue.async { [weak self] in
        self?.start(arguments, result: result)
      }
    case "pause":
      queue.async { [weak self] in
        self?.pause(arguments, result: result)
      }
    case "resume":
      queue.async { [weak self] in
        self?.resume(arguments, result: result)
      }
    case "stop":
      queue.async { [weak self] in
        self?.stop(arguments, result: result)
      }
    case "recoverableSessions":
      queue.async { [weak self] in
        self?.recoverableSessions(arguments, result: result)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func runPreflight(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard
      let sessionRoot = arguments["sessionRoot"] as? String,
      let minimumFreeBytes = (arguments["minimumFreeBytes"] as? NSNumber)?.int64Value,
      minimumFreeBytes >= 0,
      let captionModelAvailable = arguments["captionModelAvailable"] as? Bool,
      let requestPermissions = arguments["requestPermissions"] as? Bool
    else {
      result(error("CAPTURE_ARGUMENTS_INVALID", "Capture preflight arguments are invalid"))
      return
    }

    let completionLock = NSLock()
    var didComplete = false
    let complete: (String) -> Void = { [weak self] microphonePermission in
      completionLock.lock()
      guard !didComplete else {
        completionLock.unlock()
        return
      }
      didComplete = true
      completionLock.unlock()
      guard let self else { return }
      self.queue.async {
        let value = self.preflight(
          sessionRoot: sessionRoot,
          minimumFreeBytes: minimumFreeBytes,
          captionModelAvailable: captionModelAvailable,
          microphonePermission: microphonePermission
        )
        DispatchQueue.main.async {
          result(value)
        }
      }
    }
    if requestPermissions &&
      AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined
    {
      MicrophoneCapture.requestPermission { granted in
        complete(granted ? "granted" : "denied")
      }
      // TCC can retain an obsolete requirement for an ad-hoc Debug build after
      // its cdhash changes. Do not leave Flutter's preflight page loading
      // forever if macOS opens a prompt but never calls the completion handler.
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
        complete(MicrophoneCapture.permissionWireState())
      }
    } else {
      complete(MicrophoneCapture.permissionWireState())
    }
  }

  private func preflight(
    sessionRoot: String,
    minimumFreeBytes: Int64,
    captionModelAvailable: Bool,
    microphonePermission: String
  ) -> [String: Any] {
    let root = URL(fileURLWithPath: sessionRoot, isDirectory: true)
    try? FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let available = (
      try? root.resourceValues(
        forKeys: [.volumeAvailableCapacityForImportantUsageKey]
      ).volumeAvailableCapacityForImportantUsage
    ) ?? 0
    var reasons = [String]()
    if microphonePermission != "granted" {
      reasons.append("microphone_permission_\(microphonePermission)")
    }
    if MicrophoneCapture.devices().isEmpty {
      reasons.append("microphone_device_missing")
    }
    if available < minimumFreeBytes {
      reasons.append("disk_space_low")
    }
    let microphoneOnly = shouldUseMicrophoneOnlyMode()
    let systemAudioPermission = microphoneOnly
      ? "unavailable"
      : "not_determined"
    let captureMode = microphoneOnly ? "microphone_only" : "dual_track"
    return [
      "minimumMacosVersion": "13.0",
      "systemAudioMinimumMacosVersion": "14.2",
      "captureMode": captureMode,
      "systemAudioPermission": systemAudioPermission,
      "microphonePermission": microphonePermission,
      "microphones": MicrophoneCapture.devices(),
      "availableBytes": available,
      "requiredBytes": minimumFreeBytes,
      "captionModelAvailable": captionModelAvailable,
      "canStart": reasons.isEmpty,
      "blockingReasons": reasons,
    ]
  }

  private func start(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard
      let nextSessionID = bounded(arguments["sessionId"], maximum: 128),
      nextSessionID.hasPrefix("session-"),
      let sessionRoot = boundedPath(arguments["sessionRoot"]),
      let idempotencyKey = bounded(arguments["idempotencyKey"], maximum: 160),
      let minimumFreeBytes = (arguments["minimumFreeBytes"] as? NSNumber)?.int64Value,
      minimumFreeBytes >= 0
    else {
      finish(
        result,
        error("CAPTURE_ARGUMENTS_INVALID", "Capture start arguments are invalid")
      )
      return
    }
    if let cached = lastResults[idempotencyKey] {
      finish(result, cached)
      return
    }
    let stoppedPartial = state == "partial_capture" &&
      systemCapture == nil &&
      microphoneCapture == nil
    guard [
      "idle",
      "recoverable",
      "completed",
      "failed",
    ].contains(state) || stoppedPartial else {
      finish(result, illegalTransition("start"))
      return
    }
    let canonicalRoot = URL(fileURLWithPath: sessionRoot, isDirectory: true)
      .standardizedFileURL
    guard canonicalRoot.path.contains("/Application Support/") else {
      finish(
        result,
        error("CAPTURE_ROOT_UNSAFE", "Capture root must be private app support")
      )
      return
    }
    let preflightValue = preflight(
      sessionRoot: canonicalRoot.path,
      minimumFreeBytes: minimumFreeBytes,
      captionModelAvailable: arguments["captionEnabled"] as? Bool == true,
      microphonePermission: MicrophoneCapture.permissionWireState()
    )
    guard preflightValue["canStart"] as? Bool == true else {
      finish(
        result,
        error(
          "CAPTURE_PREFLIGHT_FAILED",
          "Capture preflight did not pass",
          details: preflightValue
        )
      )
      return
    }
    var requestedMicrophoneID: String?
    if let rawMicrophoneID = arguments["microphoneDeviceId"],
      !(rawMicrophoneID is NSNull)
    {
      guard
        let parsedMicrophoneID = bounded(
          rawMicrophoneID,
          maximum: 512
        )
      else {
        finish(
          result,
          error(
            "CAPTURE_ARGUMENTS_INVALID",
            "Selected microphone identifier is invalid"
          )
        )
        return
      }
      requestedMicrophoneID = parsedMicrophoneID
    }
    state = "preparing"
    sessionID = nextSessionID
    captureJournal = nil
#if DEBUG
    developmentLastFrameAccounting = nil
#endif
    accumulatedMs = 0
    captureMode = "dual_track"
    partialCapture = false
    interruptionReason = nil
    do {
      let nextMicrophoneCapture = MicrophoneCapture(
        selectedDeviceUniqueID: requestedMicrophoneID,
        healthHandler: { [weak self] reason in
          self?.queue.async {
            self?.handleMicrophoneConfigurationChange(reason)
          }
        }
      )
      try nextMicrophoneCapture.start()
      guard let microphoneFormat = nextMicrophoneCapture.format else {
        nextMicrophoneCapture.teardown()
        throw DesktopMicrophoneCaptureError.invalidFormat
      }
      let microphoneOnly = shouldUseMicrophoneOnlyMode()
      var nextSystemCapture: Any?
      var systemFormat: AVAudioFormat?
      if !microphoneOnly {
        guard #available(macOS 14.2, *) else {
          nextMicrophoneCapture.teardown()
          throw DesktopSystemAudioCaptureError.unsupportedMacos
        }
        let capture = CoreAudioProcessTapCapture()
        do {
          try capture.start()
        } catch {
          nextMicrophoneCapture.teardown()
          throw error
        }
        guard let format = capture.format else {
          capture.teardown()
          nextMicrophoneCapture.teardown()
          throw DesktopMicrophoneCaptureError.invalidFormat
        }
        nextSystemCapture = capture
        systemFormat = format
        captureMode = "dual_track"
      } else {
        captureMode = "microphone_only"
      }
      let nextJournal: CaptureChunkJournal
      do {
        nextJournal = try CaptureChunkJournal(
          root: canonicalRoot,
          sessionID: nextSessionID,
          systemFormat: systemFormat,
          microphoneFormat: microphoneFormat,
          captureMode: captureMode,
          failureHandler: { [weak self] kind, reason in
            self?.queue.async {
              self?.handleTrackFailure(kind, reason: reason)
            }
          }
        )
        try nextJournal.beginRecording()
      } catch {
        if #available(macOS 14.2, *),
          let capture = nextSystemCapture as? CoreAudioProcessTapCapture
        {
          capture.teardown()
        }
        nextMicrophoneCapture.teardown()
        throw error
      }
      if #available(macOS 14.2, *),
        let capture = nextSystemCapture as? CoreAudioProcessTapCapture
      {
        capture.setBufferHandler { [weak nextJournal] buffer in
          nextJournal?.append(buffer, to: .systemAudio)
        }
      }
      nextMicrophoneCapture.setBufferHandler { [weak nextJournal] buffer in
        nextJournal?.append(buffer, to: .microphone)
      }
      systemCapture = nextSystemCapture
      microphoneCapture = nextMicrophoneCapture
      captureJournal = nextJournal
      let nextDiskMonitor = CaptureDiskMonitor()
      nextDiskMonitor.start(
        root: canonicalRoot,
        minimumFreeBytes: minimumFreeBytes
      ) { [weak self] availableBytes in
        self?.queue.async {
          self?.handleLowDisk(
            availableBytes: availableBytes,
            requiredBytes: minimumFreeBytes
          )
        }
      }
      diskMonitor = nextDiskMonitor
      systemHealthy = nextSystemCapture != nil
      microphoneHealthy = true
      startedAt = .now()
      state = "recording"
      startMeterUpdates()
      let value = snapshot()
      lastResults[idempotencyKey] = value
      publish(value)
      finish(result, value)
    } catch {
      teardown()
      state = "failed"
      finish(
        result,
        self.error(
          "CAPTURE_NATIVE_START_FAILED",
          "The selected native authority tracks could not start",
          details: ["nativeError": String(describing: error)]
        )
      )
    }
  }

  private func pause(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard let context = controlContext(arguments, result: result) else { return }
    if let cached = lastResults[context.idempotencyKey] {
      finish(result, cached)
      return
    }
    guard state == "recording" || state == "partial_capture" else {
      finish(result, illegalTransition("pause"))
      return
    }
    accumulatedMs += elapsedSinceStart()
    if #available(macOS 14.2, *),
      let capture = systemCapture as? CoreAudioProcessTapCapture
    {
      capture.pause()
    }
    microphoneCapture?.pause()
    do {
      try captureJournal?.pause(at: accumulatedMs)
    } catch {
      partialCapture = true
      state = "partial_capture"
      finish(
        result,
        self.error(
          "CAPTURE_CHUNK_FINALIZE_FAILED",
          "Capture chunks could not be finalized while pausing",
          details: ["nativeError": String(describing: error)]
        )
      )
      return
    }
    state = "paused"
    interruptionReason = nil
    let value = snapshot()
    lastResults[context.idempotencyKey] = value
    publish(value)
    finish(result, value)
  }

  private func resume(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard let context = controlContext(arguments, result: result) else { return }
    if let cached = lastResults[context.idempotencyKey] {
      finish(result, cached)
      return
    }
    guard state == "paused" else {
      finish(result, illegalTransition("resume"))
      return
    }
    do {
      if #available(macOS 14.2, *),
        let capture = systemCapture as? CoreAudioProcessTapCapture
      {
        try capture.start()
      }
      try microphoneCapture?.start()
      startedAt = .now()
      guard systemCapture != nil || microphoneCapture != nil else {
        throw DesktopMicrophoneCaptureError.noInputDevice
      }
      try captureJournal?.resume(
        at: accumulatedMs,
        partial: partialCapture
      )
      state = partialCapture ? "partial_capture" : "recording"
      interruptionReason = nil
      let value = snapshot()
      lastResults[context.idempotencyKey] = value
      publish(value)
      finish(result, value)
    } catch {
      partialCapture = true
      state = "partial_capture"
      finish(
        result,
        self.error(
          "CAPTURE_NATIVE_RESUME_FAILED",
          "One or more tracks could not resume",
          details: ["nativeError": String(describing: error)]
        )
      )
    }
  }

  private func stop(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard let context = controlContext(arguments, result: result) else { return }
    if let cached = lastResults[context.idempotencyKey] {
      finish(result, cached)
      return
    }
    guard ["recording", "paused", "partial_capture"].contains(state) else {
      finish(result, illegalTransition("stop"))
      return
    }
    if state == "recording" || state == "partial_capture" {
      accumulatedMs += elapsedSinceStart()
    }
    state = "finalizing"
    var stoppedSystemObservedFrames: UInt64 = 0
    var stoppedSystemDeliveredFrames: UInt64 = 0
    if #available(macOS 14.2, *),
      let capture = systemCapture as? CoreAudioProcessTapCapture
    {
      stoppedSystemObservedFrames = capture.observedFrames
      stoppedSystemDeliveredFrames = capture.deliveredFrames
    }
    let stoppedMicrophoneCapture = microphoneCapture
    teardown()
    systemHealthy = false
    microphoneHealthy = false
    do {
      try captureJournal?.finalize(
        at: accumulatedMs,
        partial: partialCapture
      )
    } catch {
      partialCapture = true
      captureJournal?.markRecoverable(at: accumulatedMs)
    }
#if DEBUG
    let committed = captureJournal?.committedFramesByTrack() ?? [:]
    let systemDelivered = stoppedSystemDeliveredFrames
    let microphoneDelivered = stoppedMicrophoneCapture?.deliveredFrames ?? 0
    let systemCommitted = committed[NativeCaptureTrack.systemAudio.rawValue] ?? 0
    let microphoneCommitted = committed[NativeCaptureTrack.microphone.rawValue] ?? 0
    developmentLastFrameAccounting = [
      "schemaVersion": 1,
      "sessionId": context.sessionID,
      "measurement": "native_callback_to_durable_chunk",
      "systemAudio": [
        "observedFrames": stoppedSystemObservedFrames,
        "deliveredFrames": systemDelivered,
        "committedFrames": systemCommitted,
        "lostFrames": Int64(systemDelivered) - Int64(systemCommitted),
      ],
      "microphone": [
        "observedFrames": stoppedMicrophoneCapture?.observedFrames ?? 0,
        "deliveredFrames": microphoneDelivered,
        "committedFrames": microphoneCommitted,
        "lostFrames": Int64(microphoneDelivered) - Int64(microphoneCommitted),
      ],
    ]
#endif
    state = partialCapture ? "partial_capture" : "completed"
    let value = snapshot()
    lastResults[context.idempotencyKey] = value
    publish(value)
    finish(result, value)
  }

  private func recoverableSessions(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard let captureRoot = boundedPath(arguments["captureRoot"]) else {
      finish(
        result,
        error("CAPTURE_ARGUMENTS_INVALID", "Capture root is invalid")
      )
      return
    }
    let root = URL(fileURLWithPath: captureRoot, isDirectory: true)
    let children = (
      try? FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
      )
    ) ?? []
    let recoverable = children.compactMap { child -> [String: Any]? in
      guard let report = CaptureChunkJournal.recoverSession(at: child) else {
        return nil
      }
      guard report.snapshot["state"] as? String != "completed" else {
        return nil
      }
      return report.snapshot
    }
    finish(result, recoverable)
  }

  private func controlContext(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) -> (sessionID: String, idempotencyKey: String)? {
    guard
      let requestedSession = bounded(arguments["sessionId"], maximum: 128),
      requestedSession == sessionID,
      let idempotencyKey = bounded(arguments["idempotencyKey"], maximum: 160)
    else {
      finish(
        result,
        error("CAPTURE_SESSION_MISMATCH", "Capture session does not match")
      )
      return nil
    }
    return (requestedSession, idempotencyKey)
  }

  private func snapshot() -> [String: Any] {
    let timeline = currentTimelineMs()
    let durable = captureJournal?.snapshot(
      systemHealthy: systemHealthy,
      microphoneHealthy: microphoneHealthy,
      partial: partialCapture
    )
    return [
      "sessionId": sessionID ?? "session-unavailable",
      "state": state,
      "captureMode": captureMode,
      "captureTimelineMs": max(0, timeline),
      "systemAudioHealthy": systemHealthy,
      "microphoneHealthy": microphoneHealthy,
      "systemAudioLevel": systemAudioLevel(),
      "microphoneLevel": microphoneCapture?.normalizedPeak ?? 0,
      "partialCapture": partialCapture,
      "finalizedChunkCount":
        durable?["finalizedChunkCount"] as? Int ?? 0,
      "eventCount": durable?["eventCount"] as? Int ?? 0,
      "interruptionReason": interruptionReason ?? NSNull(),
    ]
  }

  private func currentTimelineMs() -> Int {
    let activelyCapturing = state == "recording" ||
      state == "partial_capture"
    return accumulatedMs + (activelyCapturing ? elapsedSinceStart() : 0)
  }

  private func elapsedSinceStart() -> Int {
    let nanos = DispatchTime.now().uptimeNanoseconds -
      startedAt.uptimeNanoseconds
    return Int(nanos / 1_000_000)
  }

  private func publish(_ value: [String: Any]) {
    DispatchQueue.main.async { [weak self] in
      self?.eventSink?(value)
      self?.recordingMenuBarController?.update(
        state: value["state"] as? String ?? "idle",
        partialCapture: value["partialCapture"] as? Bool ?? false,
        interruptionReason: value["interruptionReason"] as? String
      )
    }
  }

  private func startMeterUpdates() {
    meterTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(
      deadline: .now() + .milliseconds(250),
      repeating: .milliseconds(250),
      leeway: .milliseconds(40)
    )
    timer.setEventHandler { [weak self] in
      guard let self,
        ["recording", "paused", "partial_capture"].contains(self.state)
      else { return }
      self.publish(self.snapshot())
    }
    meterTimer = timer
    timer.resume()
  }

  private func systemAudioLevel() -> Double {
    if #available(macOS 14.2, *),
      let capture = systemCapture as? CoreAudioProcessTapCapture
    {
      return capture.normalizedPeak
    }
    return 0
  }

  private func shouldUseMicrophoneOnlyMode() -> Bool {
#if DEBUG
    if ProcessInfo.processInfo.environment[
      "VOICE2TEXT_CAPTURE_FORCE_MICROPHONE_ONLY"
    ] == "1" {
      return true
    }
#endif
    if #available(macOS 14.2, *) {
      return false
    }
    return true
  }

  private func teardown() {
    meterTimer?.cancel()
    meterTimer = nil
    diskMonitor?.stop()
    diskMonitor = nil
    if #available(macOS 14.2, *),
      let capture = systemCapture as? CoreAudioProcessTapCapture
    {
      capture.teardown()
    }
    systemCapture = nil
    microphoneCapture?.teardown()
    microphoneCapture = nil
  }

  private func handleMicrophoneConfigurationChange(_ reason: String) {
    guard microphoneHealthy else { return }
    let timeline = currentTimelineMs()
    captureJournal?.recordEvent(
      kind: "device_changed",
      track: NativeCaptureTrack.microphone.rawValue,
      reason: reason,
      at: timeline
    )
    handleTrackFailure(.microphone, reason: reason)
  }

  private func handleSystemWillSleep() {
    guard state == "recording" || state == "partial_capture" else {
      return
    }
    let timeline = currentTimelineMs()
    accumulatedMs = timeline
    captureJournal?.recordEvent(
      kind: "system_sleep",
      track: "all",
      reason: "macos_will_sleep",
      at: timeline
    )
    if #available(macOS 14.2, *),
      let capture = systemCapture as? CoreAudioProcessTapCapture
    {
      capture.pause()
    }
    microphoneCapture?.pause()
    do {
      try captureJournal?.pause(at: timeline)
      state = "paused"
      interruptionReason = "system_sleep"
    } catch {
      partialCapture = true
      state = "failed"
      interruptionReason = "system_sleep_pause_failed"
      captureJournal?.markRecoverable(at: timeline)
      teardown()
      systemHealthy = false
      microphoneHealthy = false
    }
    publish(snapshot())
  }

  private func handleSystemDidWake() {
    guard state == "paused", interruptionReason == "system_sleep" else {
      return
    }
    captureJournal?.recordEvent(
      kind: "system_wake",
      track: "all",
      reason: "manual_resume_required",
      at: accumulatedMs
    )
    interruptionReason = "system_wake_requires_resume"
    publish(snapshot())
  }

  private func handleTrackFailure(
    _ kind: NativeCaptureTrack,
    reason: String
  ) {
    guard ["recording", "paused", "partial_capture"].contains(state) else {
      return
    }
    partialCapture = true
    switch kind {
    case .systemAudio:
      if #available(macOS 14.2, *),
        let capture = systemCapture as? CoreAudioProcessTapCapture
      {
        capture.teardown()
      }
      systemCapture = nil
      systemHealthy = false
    case .microphone:
      microphoneCapture?.teardown()
      microphoneCapture = nil
      microphoneHealthy = false
    }
    if !systemHealthy && !microphoneHealthy {
      let timeline = currentTimelineMs()
      accumulatedMs = timeline
      state = "finalizing"
      teardown()
      do {
        try captureJournal?.finalize(at: timeline, partial: true)
        state = "failed"
      } catch {
        captureJournal?.markRecoverable(at: timeline)
        state = "failed"
      }
    } else if state != "paused" {
      state = "partial_capture"
    }
    publish(snapshot())
  }

  private func handleLowDisk(
    availableBytes: Int64,
    requiredBytes: Int64
  ) {
    guard ["recording", "paused", "partial_capture"].contains(state) else {
      return
    }
    let timeline = currentTimelineMs()
    accumulatedMs = timeline
    partialCapture = true
    captureJournal?.recordEvent(
      kind: "disk_low",
      track: "all",
      reason:
        "available_bytes=\(availableBytes),required_bytes=\(requiredBytes)",
      at: timeline
    )
    state = "finalizing"
    teardown()
    systemHealthy = false
    microphoneHealthy = false
    do {
      try captureJournal?.finalize(at: timeline, partial: true)
      state = "partial_capture"
    } catch {
      captureJournal?.markRecoverable(at: timeline)
      state = "failed"
    }
    publish(snapshot())
  }

#if DEBUG
  private func developmentInjectFault(
    _ arguments: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard
      let requestedSession = bounded(arguments["sessionId"], maximum: 128),
      requestedSession == sessionID,
      let fault = bounded(arguments["fault"], maximum: 80)
    else {
      finish(
        result,
        error(
          "CAPTURE_DEVELOPMENT_FAULT_INVALID",
          "Development capture fault arguments are invalid"
        )
      )
      return
    }
    let timeline = currentTimelineMs()
    switch fault {
    case "microphone_disconnect":
      captureJournal?.recordEvent(
        kind: "device_changed",
        track: NativeCaptureTrack.microphone.rawValue,
        reason: "development_injected_microphone_disconnect",
        at: timeline
      )
      handleTrackFailure(
        .microphone,
        reason: "development_injected_microphone_disconnect"
      )
    case "system_encoder_failure":
      captureJournal?.recordEvent(
        kind: "encoder_failed",
        track: NativeCaptureTrack.systemAudio.rawValue,
        reason: "development_injected_system_encoder_failure",
        at: timeline
      )
      handleTrackFailure(
        .systemAudio,
        reason: "development_injected_system_encoder_failure"
      )
    case "disk_low":
      handleLowDisk(availableBytes: 0, requiredBytes: 1)
    default:
      finish(
        result,
        error(
          "CAPTURE_DEVELOPMENT_FAULT_INVALID",
          "Unknown development capture fault"
        )
      )
      return
    }
    finish(result, snapshot())
  }
#endif

  private func illegalTransition(_ action: String) -> FlutterError {
    error(
      "CAPTURE_ILLEGAL_TRANSITION",
      "Cannot \(action) while capture state is \(state)",
      details: ["state": state, "action": action]
    )
  }

  private func error(
    _ code: String,
    _ message: String,
    details: Any? = nil
  ) -> FlutterError {
    FlutterError(code: code, message: message, details: details)
  }

  private func finish(_ result: @escaping FlutterResult, _ value: Any?) {
    DispatchQueue.main.async {
      result(value)
    }
  }

  private func bounded(_ raw: Any?, maximum: Int) -> String? {
    guard let value = raw as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      !trimmed.isEmpty,
      trimmed.count <= maximum,
      trimmed.unicodeScalars.allSatisfy({ $0.value >= 0x20 })
    else {
      return nil
    }
    return trimmed
  }

  private func boundedPath(_ raw: Any?) -> String? {
    guard let path = bounded(raw, maximum: 2048), path.hasPrefix("/") else {
      return nil
    }
    return URL(fileURLWithPath: path).standardizedFileURL.path
  }
}
