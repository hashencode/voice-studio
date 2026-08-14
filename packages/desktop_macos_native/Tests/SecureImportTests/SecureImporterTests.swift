import Foundation
import Testing
@testable import SecureImport

@Suite("Secure import containment and normalization")
struct SecureImporterTests {
  @Test("normalizes a regular wave to validated mono 16 kHz PCM")
  func normalizesWave() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 8_000, channels: 2)

    let receipt = try SecureImporter().importMedia(
      SecureImportRequest(
        sourcePath: source.path,
        destinationRoot: fixture.destination.path,
        destinationId: "meeting-123456789abc",
        maxSourceBytes: 8 * 1024 * 1024,
        minimumFreeBytes: 0,
        temporaryStorageMultiplier: 2,
        maxDurationMs: 60_000
      )
    )

    #expect(receipt.schemaVersion == 1)
    #expect(receipt.sampleRate == 16_000)
    #expect(receipt.channels == 1)
    #expect(receipt.encoding == "pcm_s16le_wav")
    #expect(receipt.normalizedPath.hasPrefix(fixture.destination.path + "/complete/"))
    #expect(receipt.sourceSha256.count == 64)
    #expect(receipt.normalizedSha256.count == 64)
    #expect(try validatePCM16kMonoWave(at: receipt.normalizedPath).durationMs > 0)
  }

  @Test("rejects links, sparse inputs, replacement, truncation, hash mismatch, and low disk")
  func rejectsUnsafeInputs() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    let symlink = fixture.root.appending(path: "source-link.wav")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
    #expect(throws: SecureImportFailure.self) {
      _ = try fixture.importer.importMedia(fixture.request(source: symlink))
    }

    let hardlink = fixture.root.appending(path: "source-hardlink.wav")
    try FileManager.default.linkItem(at: source, to: hardlink)
    #expect(throws: SecureImportFailure.self) {
      _ = try fixture.importer.importMedia(fixture.request(source: source))
    }
    try FileManager.default.removeItem(at: hardlink)

    let replacementSource = fixture.root.appending(path: "replacement.wav")
    try writePCMFixture(to: replacementSource, sampleRate: 16_000, channels: 1)
    let replacingImporter = SecureImporter(
      availableCapacity: { _ in Int64.max },
      afterSourceCopy: { path in
        try FileManager.default.removeItem(atPath: path)
        try Data("replacement".utf8).write(to: URL(filePath: path))
      }
    )
    #expect(throws: SecureImportFailure.self) {
      _ = try replacingImporter.importMedia(fixture.request(source: replacementSource))
    }

    let sparse = fixture.root.appending(path: "sparse.wav")
    FileManager.default.createFile(atPath: sparse.path, contents: Data("RIFF".utf8))
    let sparseHandle = try FileHandle(forWritingTo: sparse)
    try sparseHandle.truncate(atOffset: 2 * 1024 * 1024)
    try sparseHandle.close()
    #expect(throws: SecureImportFailure.self) {
      _ = try fixture.importer.importMedia(fixture.request(source: sparse))
    }

    var mismatch = fixture.request(source: source)
    mismatch.expectedSourceSha256 = String(repeating: "0", count: 64)
    #expect(throws: SecureImportFailure.self) {
      _ = try fixture.importer.importMedia(mismatch)
    }

    let truncated = fixture.root.appending(path: "truncated.wav")
    try Data("RIFF\0\0\0\0WAVE".utf8).write(to: truncated)
    #expect(throws: SecureImportFailure.self) {
      _ = try fixture.importer.importMedia(fixture.request(source: truncated))
    }

    let lowDisk = SecureImporter(availableCapacity: { _ in 1 })
    #expect(throws: SecureImportFailure.self) {
      _ = try lowDisk.importMedia(fixture.request(source: source))
    }
  }

  @Test("cleanup never follows symlinks and removes only expired temporary files")
  func cleanupDoesNotFollowSymlinks() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let outside = fixture.root.appending(path: "outside")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let protected = outside.appending(path: "protected.partial")
    try Data("keep".utf8).write(to: protected)
    let staging = fixture.destination.appending(path: "staging")
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    let symlink = staging.appending(path: "escape")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
    let expired = staging.appending(path: "expired.partial")
    try Data("remove".utf8).write(to: expired)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1)],
      ofItemAtPath: expired.path
    )

    let removed = try cleanupSecureImportTemporaryFiles(
      destinationRoot: fixture.destination.path,
      olderThan: 24 * 60 * 60,
      now: Date(timeIntervalSince1970: 200_000)
    )

    #expect(removed == 1)
    #expect(FileManager.default.fileExists(atPath: protected.path))
    #expect(FileManager.default.fileExists(atPath: symlink.path))
  }

  @Test("discard and cleanup reject a destination whose ancestor was replaced by a symlink")
  func destructiveOperationsRejectReplacedAncestor() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let lexicalParent = fixture.root.appending(path: "capability-parent")
    let displacedParent = fixture.root.appending(path: "capability-parent-original")
    let attackerParent = fixture.root.appending(path: "attacker-parent")
    let lexicalDestination = lexicalParent.appending(path: "destination")
    let attackerDestination = attackerParent.appending(path: "destination")
    try FileManager.default.createDirectory(
      at: lexicalDestination.appending(path: "staging"),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: attackerDestination.appending(path: "staging"),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: attackerDestination.appending(path: "complete"),
      withIntermediateDirectories: true
    )
    let attackerTemporary = attackerDestination.appending(path: "staging/protected.partial")
    let attackerComplete = attackerDestination.appending(path: "complete/protected.wav")
    try Data("keep".utf8).write(to: attackerTemporary)
    try Data("keep".utf8).write(to: attackerComplete)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1)],
      ofItemAtPath: attackerTemporary.path
    )
    try FileManager.default.moveItem(at: lexicalParent, to: displacedParent)
    try FileManager.default.createSymbolicLink(
      at: lexicalParent,
      withDestinationURL: attackerParent
    )

    #expect(throws: SecureImportFailure.self) {
      _ = try cleanupSecureImportTemporaryFiles(
        destinationRoot: lexicalDestination.path,
        olderThan: 1,
        now: Date(timeIntervalSince1970: 200_000)
      )
    }
    #expect(throws: SecureImportFailure.self) {
      try discardSecureImportedFile(
        path: lexicalDestination.appending(path: "complete/protected.wav").path,
        destinationRoot: lexicalDestination.path
      )
    }
    #expect(FileManager.default.fileExists(atPath: attackerTemporary.path))
    #expect(FileManager.default.fileExists(atPath: attackerComplete.path))
  }

  @Test("rejects limits above the fixed import envelope")
  func rejectsUnboundedLimits() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    var oversizedSourceLimit = fixture.request(source: source)
    oversizedSourceLimit.maxSourceBytes = 4 * 1024 * 1024 * 1024 + 1
    #expect(failureCode { try fixture.importer.importMedia(oversizedSourceLimit) } == "IMPORT_ARGUMENTS_INVALID")
    var oversizedDurationLimit = fixture.request(source: source)
    oversizedDurationLimit.maxDurationMs = 4 * 60 * 60 * 1_000 + 1
    #expect(failureCode { try fixture.importer.importMedia(oversizedDurationLimit) } == "IMPORT_ARGUMENTS_INVALID")
  }

  @Test("an oversized receipt leaves no committed file")
  func receiptLimitDoesNotLeaveFinalFile() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    let importer = SecureImporter(
      availableCapacity: { _ in Int64.max },
      maximumReceiptBytes: 1
    )

    #expect(failureCode { try importer.importMedia(fixture.request(source: source)) } == "IMPORT_RECEIPT_TOO_LARGE")
    #expect(
      !FileManager.default.fileExists(
        atPath: fixture.destination.appending(path: "complete/meeting-123456789abc.wav").path
      )
    )
  }

  @Test("import rejects a replaced destination ancestor without touching the attacker tree")
  func importPinsDestinationDirectories() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    let lexicalParent = fixture.root.appending(path: "profile-parent")
    let displacedParent = fixture.root.appending(path: "profile-parent-original")
    let attackerParent = fixture.root.appending(path: "attacker-parent")
    let destination = lexicalParent.appending(path: "media")
    let attackerDestination = attackerParent.appending(path: "media")
    try FileManager.default.createDirectory(at: lexicalParent, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: attackerDestination.appending(path: "staging"),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: attackerDestination.appending(path: "complete"),
      withIntermediateDirectories: true
    )
    let protected = attackerDestination.appending(
      path: "complete/meeting-123456789abc.wav"
    )
    try Data("attacker-owned".utf8).write(to: protected)
    let importer = SecureImporter(
      availableCapacity: { _ in Int64.max },
      afterSourceCopy: { _ in
        try FileManager.default.moveItem(at: lexicalParent, to: displacedParent)
        try FileManager.default.createSymbolicLink(
          at: lexicalParent,
          withDestinationURL: attackerParent
        )
      }
    )
    var request = fixture.request(source: source)
    request.destinationRoot = destination.path

    #expect(failureCode { try importer.importMedia(request) } == "IMPORT_DESTINATION_UNSAFE")
    #expect(try Data(contentsOf: protected) == Data("attacker-owned".utf8))
    let displacedStaging = displacedParent.appending(path: "media/staging")
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: displacedStaging.path).isEmpty
    )
  }

  @Test("source open rejects a symlink ancestor and detects ancestor replacement")
  func sourceParentChainIsPinned() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let realParent = fixture.root.appending(path: "real-source-parent")
    let lexicalParent = fixture.root.appending(path: "selected-source-parent")
    try FileManager.default.createDirectory(at: realParent, withIntermediateDirectories: true)
    let realSource = realParent.appending(path: "selected.wav")
    try writePCMFixture(to: realSource, sampleRate: 16_000, channels: 1)
    try FileManager.default.createSymbolicLink(
      at: lexicalParent,
      withDestinationURL: realParent
    )
    let linkedSource = lexicalParent.appending(path: "selected.wav")
    #expect(
      failureCode { try fixture.importer.importMedia(fixture.request(source: linkedSource)) }
        == "IMPORT_SOURCE_LINK_REJECTED"
    )
    try FileManager.default.removeItem(at: lexicalParent)
    try FileManager.default.moveItem(at: realParent, to: lexicalParent)

    let displacedParent = fixture.root.appending(path: "selected-source-parent-original")
    let attackerParent = fixture.root.appending(path: "attacker-source-parent")
    try FileManager.default.createDirectory(at: attackerParent, withIntermediateDirectories: true)
    let attackerSource = attackerParent.appending(path: "selected.wav")
    try writePCMFixture(to: attackerSource, sampleRate: 8_000, channels: 2)
    let attackerBytes = try Data(contentsOf: attackerSource)
    let importer = SecureImporter(
      availableCapacity: { _ in Int64.max },
      afterSourceCopy: { _ in
        try FileManager.default.moveItem(at: lexicalParent, to: displacedParent)
        try FileManager.default.createSymbolicLink(
          at: lexicalParent,
          withDestinationURL: attackerParent
        )
      }
    )
    #expect(
      failureCode { try importer.importMedia(fixture.request(source: linkedSource)) }
        == "IMPORT_SOURCE_CHANGED"
    )
    #expect(try Data(contentsOf: attackerSource) == attackerBytes)
  }

  @Test("import rejects replaced staging and complete entries while cleaning through pinned dirfds")
  func importPinsStagingAndCompleteDirectories() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    let displacedStaging = fixture.destination.appending(path: "staging-original")
    let displacedComplete = fixture.destination.appending(path: "complete-original")
    let attackerStaging = fixture.root.appending(path: "attacker-staging")
    let attackerComplete = fixture.root.appending(path: "attacker-complete")
    try FileManager.default.createDirectory(at: attackerStaging, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: attackerComplete, withIntermediateDirectories: true)
    let protected = attackerComplete.appending(path: "meeting-123456789abc.wav")
    try Data("attacker-owned".utf8).write(to: protected)
    let importer = SecureImporter(
      availableCapacity: { _ in Int64.max },
      afterSourceCopy: { _ in
        let staging = fixture.destination.appending(path: "staging")
        let complete = fixture.destination.appending(path: "complete")
        try FileManager.default.moveItem(at: staging, to: displacedStaging)
        try FileManager.default.moveItem(at: complete, to: displacedComplete)
        try FileManager.default.createSymbolicLink(
          at: staging,
          withDestinationURL: attackerStaging
        )
        try FileManager.default.createSymbolicLink(
          at: complete,
          withDestinationURL: attackerComplete
        )
      }
    )

    #expect(
      failureCode { try importer.importMedia(fixture.request(source: source)) }
        == "IMPORT_DESTINATION_UNSAFE"
    )
    #expect(try Data(contentsOf: protected) == Data("attacker-owned".utf8))
    #expect(try FileManager.default.contentsOfDirectory(atPath: displacedStaging.path).isEmpty)
  }

  @Test("normalization checks the PCM budget before every block write")
  func normalizationHonorsPCMBlockBudget() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    let destination = fixture.root.appending(path: "bounded.partial")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)

    #expect(throws: SecureImportFailure.self) {
      try normalizeToPCM16kMono(
        source: source,
        destination: destination,
        maximumPCMBytes: 64
      )
    }
    let size = try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber
    #expect((size?.int64Value ?? 0) <= 44 + 64)

    var request = fixture.request(source: source)
    request.maxDurationMs = 1
    #expect(
      failureCode { try fixture.importer.importMedia(request) }
        == "IMPORT_SOURCE_DURATION_INVALID"
    )
    #expect(
      try FileManager.default.contentsOfDirectory(
        atPath: fixture.destination.appending(path: "staging").path
      ).isEmpty
    )
  }

  @Test("WAVE validation rejects files above its streaming parser bound")
  func waveValidationIsBounded() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)

    #expect(throws: SecureImportFailure.self) {
      _ = try validatePCM16kMonoWave(
        at: source.path,
        maximumFileBytes: 64
      )
    }
  }

  @Test("a pre-existing complete file is never removed by failed publication")
  func publicationConflictPreservesExistingFile() throws {
    let fixture = try Fixture()
    defer { fixture.dispose() }
    let source = fixture.root.appending(path: "source.wav")
    try writePCMFixture(to: source, sampleRate: 16_000, channels: 1)
    let complete = fixture.destination.appending(path: "complete")
    try FileManager.default.createDirectory(at: complete, withIntermediateDirectories: true)
    let existing = complete.appending(path: "meeting-123456789abc.wav")
    let protected = Data("existing-authority".utf8)
    try protected.write(to: existing)

    #expect(
      failureCode { try fixture.importer.importMedia(fixture.request(source: source)) }
        == "IMPORT_DESTINATION_UNSAFE"
    )
    #expect(try Data(contentsOf: existing) == protected)
  }
}

private func failureCode(_ operation: () throws -> Any) -> String? {
  do {
    _ = try operation()
    return nil
  } catch let failure as SecureImportFailure {
    return failure.code
  } catch {
    return nil
  }
}

private struct Fixture {
  let root: URL
  let destination: URL
  let importer = SecureImporter()

  init() throws {
    root = URL(filePath: FileManager.default.currentDirectoryPath)
      .appending(path: "secure-import-\(UUID().uuidString)")
    destination = root.appending(path: "destination")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  func request(source: URL) -> SecureImportRequest {
    SecureImportRequest(
      sourcePath: source.path,
      destinationRoot: destination.path,
      destinationId: "meeting-123456789abc",
      maxSourceBytes: 8 * 1024 * 1024,
      minimumFreeBytes: 512,
      temporaryStorageMultiplier: 2,
      maxDurationMs: 60_000
    )
  }

  func dispose() {
    try? FileManager.default.removeItem(at: root)
  }
}

private func writePCMFixture(to url: URL, sampleRate: Int, channels: Int) throws {
  let frameCount = sampleRate / 4
  var samples = Data(capacity: frameCount * channels * 2)
  for frame in 0..<frameCount {
    let value = Int16(Double(Int16.max) * 0.2 * sin(Double(frame) * 0.05))
    for _ in 0..<channels {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { samples.append(contentsOf: $0) }
    }
  }
  var wav = Data()
  func appendASCII(_ value: String) { wav.append(Data(value.utf8)) }
  func append32(_ value: UInt32) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
  }
  func append16(_ value: UInt16) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
  }
  appendASCII("RIFF")
  append32(UInt32(36 + samples.count))
  appendASCII("WAVEfmt ")
  append32(16)
  append16(1)
  append16(UInt16(channels))
  append32(UInt32(sampleRate))
  append32(UInt32(sampleRate * channels * 2))
  append16(UInt16(channels * 2))
  append16(16)
  appendASCII("data")
  append32(UInt32(samples.count))
  wav.append(samples)
  try wav.write(to: url)
}
