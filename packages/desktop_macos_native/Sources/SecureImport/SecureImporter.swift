import AVFoundation
import CryptoKit
import Darwin
import Foundation

public enum SecureImportLimits {
  public static let maximumSourceBytes: Int64 = 4 * 1024 * 1024 * 1024
  public static let maximumMinimumFreeBytes: Int64 = 1024 * 1024 * 1024 * 1024
  public static let maximumDurationMs: Int64 = 4 * 60 * 60 * 1_000
  public static let maximumPathBytes = 4_096
  public static let maximumReceiptBytes = 4_096
}

public struct SecureImportRequest: Codable, Sendable {
  public var sourcePath: String
  public var destinationRoot: String
  public var destinationId: String
  public var expectedSourceSha256: String?
  public var maxSourceBytes: Int64
  public var minimumFreeBytes: Int64
  public var temporaryStorageMultiplier: Double
  public var maxDurationMs: Int64

  public init(
    sourcePath: String,
    destinationRoot: String,
    destinationId: String,
    expectedSourceSha256: String? = nil,
    maxSourceBytes: Int64,
    minimumFreeBytes: Int64,
    temporaryStorageMultiplier: Double,
    maxDurationMs: Int64
  ) {
    self.sourcePath = sourcePath
    self.destinationRoot = destinationRoot
    self.destinationId = destinationId
    self.expectedSourceSha256 = expectedSourceSha256
    self.maxSourceBytes = maxSourceBytes
    self.minimumFreeBytes = minimumFreeBytes
    self.temporaryStorageMultiplier = temporaryStorageMultiplier
    self.maxDurationMs = maxDurationMs
  }
}

public struct SecureImportReceipt: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let normalizedPath: String
  public let sourceSizeBytes: Int64
  public let normalizedSizeBytes: Int64
  public let sourceSha256: String
  public let normalizedSha256: String
  public let mediaType: String
  public let durationMs: Int64
  public let sampleRate: Int
  public let channels: Int
  public let encoding: String
}

public struct ValidatedWave: Equatable, Sendable {
  public let durationMs: Int64
  public let dataBytes: Int64
}

public struct SecureImportFailure: Error, Codable, Equatable, Sendable {
  public let code: String
  public let message: String

  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

public final class SecureImporter: @unchecked Sendable {
  private let availableCapacity: @Sendable (URL) throws -> Int64
  private let afterSourceCopy: @Sendable (String) throws -> Void
  private let maximumReceiptBytes: Int

  public convenience init() {
    self.init(
      availableCapacity: defaultAvailableCapacity,
      afterSourceCopy: { _ in },
      maximumReceiptBytes: SecureImportLimits.maximumReceiptBytes
    )
  }

  public init(
    availableCapacity: @escaping @Sendable (URL) throws -> Int64,
    afterSourceCopy: @escaping @Sendable (String) throws -> Void = { _ in },
    maximumReceiptBytes: Int = SecureImportLimits.maximumReceiptBytes
  ) {
    self.availableCapacity = availableCapacity
    self.afterSourceCopy = afterSourceCopy
    self.maximumReceiptBytes = maximumReceiptBytes
  }

  public func importMedia(_ request: SecureImportRequest) throws -> SecureImportReceipt {
    try validate(request)
    let rootFD = try openOrCreateDirectoryWithoutSymlinks(request.destinationRoot)
    defer { Darwin.close(rootFD) }
    let stagingFD = try openOrCreateChildDirectory(parentFD: rootFD, name: "staging")
    defer { Darwin.close(stagingFD) }
    let completeFD = try openOrCreateChildDirectory(parentFD: rootFD, name: "complete")
    defer { Darwin.close(completeFD) }
    try assertPinnedDestinationDirectories(
      rootPath: request.destinationRoot,
      rootFD: rootFD,
      stagingFD: stagingFD,
      completeFD: completeFD
    )

    let source = try openSourceWithoutSymlinkAncestors(request.sourcePath)
    defer {
      Darwin.close(source.descriptor)
      Darwin.close(source.parentDescriptor)
    }
    let sourceStat = source.identity
    guard (sourceStat.st_mode & S_IFMT) == S_IFREG else {
      throw SecureImportFailure("IMPORT_SOURCE_NOT_REGULAR", "只接受普通文件")
    }
    guard sourceStat.st_nlink == 1 else {
      throw SecureImportFailure("IMPORT_SOURCE_LINK_REJECTED", "不接受硬链接来源")
    }
    guard sourceStat.st_size > 0, sourceStat.st_size <= request.maxSourceBytes else {
      throw SecureImportFailure("IMPORT_SOURCE_SIZE_INVALID", "文件为空或超过导入上限")
    }
    if sourceStat.st_size > 4_096 && sourceStat.st_blocks * 512 < sourceStat.st_size {
      throw SecureImportFailure("IMPORT_SOURCE_SPARSE_REJECTED", "不接受稀疏文件")
    }
    let maximumPCMBytes = try checkedMultiply(request.maxDurationMs, 32)
    let sourceAndPCM = try checkedAdd(sourceStat.st_size, maximumPCMBytes)
    let scaledTemporary = try scaledBytes(
      sourceStat.st_size,
      multiplier: request.temporaryStorageMultiplier
    )
    let requiredBytes = try checkedAdd(
      max(scaledTemporary, sourceAndPCM),
      request.minimumFreeBytes
    )
    let rootURL = URL(filePath: request.destinationRoot, directoryHint: .isDirectory)
    guard try availableCapacity(rootURL) >= requiredBytes else {
      throw SecureImportFailure("IMPORT_DISK_SPACE_LOW", "目标卷空间不足")
    }

    let sourceExtension = try supportedMediaExtension(sourceFD: source.descriptor)
    let identity = "\(request.destinationId)-\(UUID().uuidString.lowercased())"
    let sourceStagingName = "\(identity).source.\(sourceExtension)"
    let pcmStagingName = "\(identity).pcm.partial"
    let destinationName = "\(request.destinationId).wav"
    let sourceStagingFD = try createPrivateFile(
      directoryFD: stagingFD,
      name: sourceStagingName
    )
    defer { Darwin.close(sourceStagingFD) }
    let pcmStagingFD = try createPrivateFile(
      directoryFD: stagingFD,
      name: pcmStagingName
    )
    defer { Darwin.close(pcmStagingFD) }
    var published = false
    var committed = false
    defer {
      _ = unlinkat(stagingFD, sourceStagingName, 0)
      _ = unlinkat(stagingFD, pcmStagingName, 0)
      if published && !committed { _ = unlinkat(completeFD, destinationName, 0) }
    }

    let copied = try copyAndHash(
      sourceFD: source.descriptor,
      sourceStat: sourceStat,
      destinationFD: sourceStagingFD,
      maximumBytes: request.maxSourceBytes
    )
    if let expected = request.expectedSourceSha256?.lowercased(), expected != copied.sha256 {
      throw SecureImportFailure("IMPORT_HASH_MISMATCH", "源文件摘要与预期不一致")
    }
    try afterSourceCopy(request.sourcePath)
    try assertUnchanged(
      source: source,
      original: sourceStat
    )
    try assertPinnedDestinationDirectories(
      rootPath: request.destinationRoot,
      rootFD: rootFD,
      stagingFD: stagingFD,
      completeFD: completeFD
    )
    let sourceStagingPath = try pathForDescriptor(sourceStagingFD)
    try normalizeToPCM16kMono(
      source: URL(filePath: sourceStagingPath),
      destinationFD: pcmStagingFD,
      maximumPCMBytes: maximumPCMBytes
    )
    let maximumNormalizedBytes = try checkedAdd(maximumPCMBytes, 4_096)
    let wave = try validatePCM16kMonoWave(
      descriptor: pcmStagingFD,
      maximumFileBytes: maximumNormalizedBytes
    )
    guard wave.durationMs > 0 else {
      throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "媒体没有可处理的音频内容")
    }
    guard wave.durationMs <= request.maxDurationMs else {
      throw SecureImportFailure("IMPORT_SOURCE_DURATION_INVALID", "会议时长超过本地处理上限")
    }
    let normalized = try hashFileStreaming(
      descriptor: pcmStagingFD,
      maximumBytes: maximumNormalizedBytes
    )
    var destinationStat = stat()
    guard fstatat(completeFD, destinationName, &destinationStat, AT_SYMLINK_NOFOLLOW) != 0,
      errno == ENOENT
    else {
      throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "目标文件名发生冲突")
    }
    let destinationPath = lexicalChildPath(
      lexicalChildPath(request.destinationRoot, "complete"),
      destinationName
    )
    let receipt = SecureImportReceipt(
      schemaVersion: 1,
      normalizedPath: destinationPath,
      sourceSizeBytes: copied.size,
      normalizedSizeBytes: normalized.size,
      sourceSha256: copied.sha256,
      normalizedSha256: normalized.sha256,
      mediaType: "audio",
      durationMs: wave.durationMs,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le_wav"
    )
    guard maximumReceiptBytes > 0,
      (try JSONEncoder().encode(receipt)).count <= maximumReceiptBytes
    else {
      throw SecureImportFailure("IMPORT_RECEIPT_TOO_LARGE", "导入回执超过大小上限")
    }
    try assertPinnedDestinationDirectories(
      rootPath: request.destinationRoot,
      rootFD: rootFD,
      stagingFD: stagingFD,
      completeFD: completeFD
    )
    guard renameatx_np(
      stagingFD,
      pcmStagingName,
      completeFD,
      destinationName,
      UInt32(RENAME_EXCL)
    ) == 0 else {
      throw SecureImportFailure("IMPORT_ATOMIC_COMMIT_FAILED", "无法原子提交导入文件")
    }
    published = true
    try assertPinnedDestinationDirectories(
      rootPath: request.destinationRoot,
      rootFD: rootFD,
      stagingFD: stagingFD,
      completeFD: completeFD
    )
    try syncDirectory(completeFD)
    committed = true
    return receipt
  }
}

public func validatePCM16kMonoWave(
  at path: String,
  maximumFileBytes: Int64 = SecureImportLimits.maximumDurationMs * 32 + 4_096
) throws -> ValidatedWave {
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else {
    throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "无法读取归一化媒体")
  }
  defer { Darwin.close(descriptor) }
  return try validatePCM16kMonoWave(
    descriptor: descriptor,
    maximumFileBytes: maximumFileBytes
  )
}

func validatePCM16kMonoWave(
  descriptor: Int32,
  maximumFileBytes: Int64
) throws -> ValidatedWave {
  var fileStat = stat()
  guard maximumFileBytes >= 44,
    fstat(descriptor, &fileStat) == 0,
    (fileStat.st_mode & S_IFMT) == S_IFREG,
    fileStat.st_size >= 44,
    fileStat.st_size <= maximumFileBytes
  else {
    throw SecureImportFailure("IMPORT_PCM_CONTRACT_INVALID", "归一化媒体大小无效")
  }
  let header = try readExactly(descriptor: descriptor, offset: 0, count: 12)
  guard ascii(header, 0..<4) == "RIFF", ascii(header, 8..<12) == "WAVE" else {
    throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "输出不是有效的 WAVE 文件")
  }
  let declaredSize = try checkedAdd(Int64(readUInt32(header, 4)), 8)
  guard declaredSize == fileStat.st_size else {
    throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "媒体数据长度与 WAVE 头不一致")
  }
  var offset: Int64 = 12
  var format: (audioFormat: UInt16, channels: UInt16, sampleRate: UInt32, bits: UInt16)?
  var dataBytes: Int64?
  while try checkedAdd(offset, 8) <= fileStat.st_size {
    let chunkHeader = try readExactly(descriptor: descriptor, offset: offset, count: 8)
    let chunk = ascii(chunkHeader, 0..<4)
    let size = Int64(readUInt32(chunkHeader, 4))
    let payload = try checkedAdd(offset, 8)
    let payloadEnd = try checkedAdd(payload, size)
    let next = try checkedAdd(payloadEnd, size % 2)
    guard next <= fileStat.st_size else {
      throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "媒体数据被截断")
    }
    if chunk == "fmt ", size >= 16 {
      let body = try readExactly(descriptor: descriptor, offset: payload, count: 16)
      format = (
        readUInt16(body, 0),
        readUInt16(body, 2),
        readUInt32(body, 4),
        readUInt16(body, 14)
      )
    } else if chunk == "data" {
      dataBytes = size
    }
    offset = next
  }
  guard offset == fileStat.st_size,
    let format, format.audioFormat == 1, format.channels == 1,
    format.sampleRate == 16_000, format.bits == 16, let dataBytes, dataBytes > 0,
    dataBytes % 2 == 0
  else {
    throw SecureImportFailure("IMPORT_PCM_CONTRACT_INVALID", "输出不符合 16 kHz 单声道 PCM 合约")
  }
  return ValidatedWave(
    durationMs: Int64((Double(dataBytes / 2) / 16_000.0 * 1_000.0).rounded()),
    dataBytes: dataBytes
  )
}

@discardableResult
public func cleanupSecureImportTemporaryFiles(
  destinationRoot: String,
  olderThan age: TimeInterval = 24 * 60 * 60,
  now: Date = Date()
) throws -> Int {
  guard age >= 0 else { return 0 }
  let root = URL(filePath: destinationRoot, directoryHint: .isDirectory).standardizedFileURL
  let rootFD = try openDirectoryChainWithoutSymlinks(root.path)
  defer { Darwin.close(rootFD) }
  let stagingFD = openat(
    rootFD,
    "staging",
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  if stagingFD < 0, errno == ENOENT { return 0 }
  guard stagingFD >= 0 else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "临时目录不是受控普通目录")
  }
  defer { Darwin.close(stagingFD) }
  guard let directory = fdopendir(dup(stagingFD)) else {
    throw SecureImportFailure("IMPORT_CLEANUP_FAILED", "无法读取受控临时目录")
  }
  defer { closedir(directory) }
  var removed = 0
  while let entry = readdir(directory) {
    let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
        String(cString: $0)
      }
    }
    if name == "." || name == ".." { continue }
    var entryStat = stat()
    guard fstatat(stagingFD, name, &entryStat, AT_SYMLINK_NOFOLLOW) == 0,
      (entryStat.st_mode & S_IFMT) == S_IFREG,
      entryStat.st_nlink == 1
    else {
      continue
    }
    let modified = Date(timeIntervalSince1970: TimeInterval(entryStat.st_mtimespec.tv_sec))
    guard now.timeIntervalSince(modified) >= age else { continue }
    guard unlinkat(stagingFD, name, 0) == 0 else {
      throw SecureImportFailure("IMPORT_CLEANUP_FAILED", "无法清理受控临时文件")
    }
    removed += 1
  }
  return removed
}

public func discardSecureImportedFile(path: String, destinationRoot: String) throws {
  let root = URL(filePath: destinationRoot, directoryHint: .isDirectory).standardizedFileURL
  let complete = root.appending(path: "complete", directoryHint: .isDirectory)
  let target = URL(filePath: path).standardizedFileURL
  let name = target.lastPathComponent
  guard target.deletingLastPathComponent().path == complete.path,
    !name.isEmpty, name != ".", name != "..", !name.contains("/")
  else {
    throw SecureImportFailure("IMPORT_DISCARD_OUTSIDE_ROOT", "拒绝清理受控目录之外的文件")
  }
  let rootFD = try openDirectoryChainWithoutSymlinks(root.path)
  defer { Darwin.close(rootFD) }
  let completeFD = openat(
    rootFD,
    "complete",
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  guard completeFD >= 0 else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "完成目录不是受控普通目录")
  }
  defer { Darwin.close(completeFD) }
  var targetStat = stat()
  guard fstatat(completeFD, name, &targetStat, AT_SYMLINK_NOFOLLOW) == 0 else {
    if errno == ENOENT { return }
    throw SecureImportFailure("IMPORT_DISCARD_FAILED", "无法检查重复导入文件")
  }
  guard (targetStat.st_mode & S_IFMT) == S_IFREG, targetStat.st_nlink == 1 else {
    throw SecureImportFailure("IMPORT_DISCARD_OUTSIDE_ROOT", "只允许清理受控普通文件")
  }
  guard unlinkat(completeFD, name, 0) == 0 else {
    throw SecureImportFailure("IMPORT_DISCARD_FAILED", "无法清理重复导入文件")
  }
}

private func validate(_ request: SecureImportRequest) throws {
  let idPattern = try! NSRegularExpression(pattern: #"^meeting-[a-zA-Z0-9-]{12,120}$"#)
  let idRange = NSRange(request.destinationId.startIndex..., in: request.destinationId)
  guard !request.sourcePath.isEmpty, !request.destinationRoot.isEmpty,
    request.sourcePath.utf8.count <= SecureImportLimits.maximumPathBytes,
    request.destinationRoot.utf8.count <= SecureImportLimits.maximumPathBytes,
    idPattern.firstMatch(in: request.destinationId, range: idRange) != nil,
    request.maxSourceBytes > 0,
    request.maxSourceBytes <= SecureImportLimits.maximumSourceBytes,
    request.minimumFreeBytes >= 0,
    request.minimumFreeBytes <= SecureImportLimits.maximumMinimumFreeBytes,
    request.temporaryStorageMultiplier >= 1, request.temporaryStorageMultiplier <= 8,
    request.temporaryStorageMultiplier.isFinite,
    request.maxDurationMs > 0,
    request.maxDurationMs <= SecureImportLimits.maximumDurationMs,
    request.expectedSourceSha256 == nil
      || request.expectedSourceSha256!.range(of: #"^[a-fA-F0-9]{64}$"#, options: .regularExpression) != nil
  else {
    throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "导入参数无效")
  }
}

private struct PinnedSource {
  let descriptor: Int32
  let parentDescriptor: Int32
  let parentPath: String
  let name: String
  let identity: stat
}

private func openOrCreateDirectoryWithoutSymlinks(_ path: String) throws -> Int32 {
  let components = try absolutePathComponents(path, code: "IMPORT_DESTINATION_UNSAFE")
  guard let name = components.last else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "目标目录不能是文件系统根目录")
  }
  let parentPath = "/" + components.dropLast().joined(separator: "/")
  let parentFD = try openDirectoryChainWithoutSymlinks(parentPath)
  defer { Darwin.close(parentFD) }
  if mkdirat(parentFD, name, S_IRWXU) != 0, errno != EEXIST {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "无法创建受控导入目录")
  }
  let descriptor = openat(
    parentFD,
    name,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  guard descriptor >= 0 else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "导入目录不是受控普通目录")
  }
  return descriptor
}

private func openOrCreateChildDirectory(parentFD: Int32, name: String) throws -> Int32 {
  if mkdirat(parentFD, name, S_IRWXU) != 0, errno != EEXIST {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "无法创建受控子目录")
  }
  let descriptor = openat(
    parentFD,
    name,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  guard descriptor >= 0 else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "受控子目录不是普通目录")
  }
  return descriptor
}

private func createPrivateFile(directoryFD: Int32, name: String) throws -> Int32 {
  let descriptor = openat(
    directoryFD,
    name,
    O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    S_IRUSR | S_IWUSR
  )
  guard descriptor >= 0 else {
    throw SecureImportFailure("IMPORT_STAGING_CREATE_FAILED", "无法创建受控临时文件")
  }
  return descriptor
}

private func openSourceWithoutSymlinkAncestors(_ path: String) throws -> PinnedSource {
  let components = try absolutePathComponents(path, code: "IMPORT_SOURCE_LINK_REJECTED")
  guard let name = components.last else {
    throw SecureImportFailure("IMPORT_SOURCE_UNREADABLE", "所选来源不是文件")
  }
  let parentPath = "/" + components.dropLast().joined(separator: "/")
  let parentFD = try openDirectoryChainWithoutSymlinks(
    parentPath,
    failureCode: "IMPORT_SOURCE_LINK_REJECTED",
    failureMessage: "来源路径包含符号链接祖先"
  )
  let descriptor = openat(parentFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else {
    Darwin.close(parentFD)
    throw SecureImportFailure(
      errno == ELOOP ? "IMPORT_SOURCE_LINK_REJECTED" : "IMPORT_SOURCE_UNREADABLE",
      errno == ELOOP ? "不接受符号链接来源" : "没有权限读取所选文件"
    )
  }
  var identity = stat()
  guard fstat(descriptor, &identity) == 0 else {
    Darwin.close(descriptor)
    Darwin.close(parentFD)
    throw SecureImportFailure("IMPORT_SOURCE_UNREADABLE", "无法读取文件身份")
  }
  return PinnedSource(
    descriptor: descriptor,
    parentDescriptor: parentFD,
    parentPath: parentPath,
    name: name,
    identity: identity
  )
}

private func copyAndHash(
  sourceFD: Int32,
  sourceStat: stat,
  destinationFD: Int32,
  maximumBytes: Int64
) throws -> (size: Int64, sha256: String) {
  guard lseek(sourceFD, 0, SEEK_SET) == 0,
    ftruncate(destinationFD, 0) == 0,
    lseek(destinationFD, 0, SEEK_SET) == 0
  else {
    throw SecureImportFailure("IMPORT_STAGING_CREATE_FAILED", "无法准备受控临时文件")
  }
  var hasher = SHA256()
  var total: Int64 = 0
  let capacity = 1024 * 1024
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
  defer { buffer.deallocate() }
  while true {
    let readCount = Darwin.read(sourceFD, buffer, capacity)
    if readCount < 0 {
      if errno == EINTR { continue }
      throw SecureImportFailure("IMPORT_SOURCE_READ_FAILED", "读取所选文件失败")
    }
    if readCount == 0 { break }
    total += Int64(readCount)
    guard total <= sourceStat.st_size, total <= maximumBytes else {
      throw SecureImportFailure("IMPORT_SOURCE_CHANGED", "导入期间文件大小发生变化")
    }
    hasher.update(data: Data(bytes: buffer, count: readCount))
    var offset = 0
    while offset < readCount {
      let written = Darwin.write(destinationFD, buffer.advanced(by: offset), readCount - offset)
      if written < 0 {
        if errno == EINTR { continue }
        throw SecureImportFailure(
          errno == ENOSPC ? "IMPORT_DISK_SPACE_LOW" : "IMPORT_DESTINATION_WRITE_FAILED",
          errno == ENOSPC ? "复制期间目标卷空间不足" : "写入受控文件失败"
        )
      }
      offset += written
    }
  }
  guard total == sourceStat.st_size, fsync(destinationFD) == 0 else {
    throw SecureImportFailure("IMPORT_SOURCE_CHANGED", "导入期间文件大小发生变化")
  }
  return (total, hasher.finalize().map { String(format: "%02x", $0) }.joined())
}

private func hashFileStreaming(
  descriptor: Int32,
  maximumBytes: Int64
) throws -> (size: Int64, sha256: String) {
  var fileStat = stat()
  guard fstat(descriptor, &fileStat) == 0,
    (fileStat.st_mode & S_IFMT) == S_IFREG,
    fileStat.st_nlink == 1,
    fileStat.st_size > 0,
    fileStat.st_size <= maximumBytes
  else {
    throw SecureImportFailure("IMPORT_PCM_CONTRACT_INVALID", "归一化媒体大小无效")
  }
  var hasher = SHA256()
  var total: Int64 = 0
  guard lseek(descriptor, 0, SEEK_SET) == 0 else {
    throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "无法定位归一化媒体")
  }
  let capacity = 1024 * 1024
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
  defer { buffer.deallocate() }
  while true {
    let count = Darwin.read(descriptor, buffer, capacity)
    if count < 0 {
      if errno == EINTR { continue }
      throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "读取归一化媒体失败")
    }
    if count == 0 { break }
    total = try checkedAdd(total, Int64(count))
    guard total <= fileStat.st_size, total <= maximumBytes else {
      throw SecureImportFailure("IMPORT_PCM_CONTRACT_INVALID", "归一化媒体大小无效")
    }
    hasher.update(data: Data(bytesNoCopy: buffer, count: count, deallocator: .none))
  }
  guard total == fileStat.st_size else {
    throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "归一化媒体读取不完整")
  }
  return (total, hasher.finalize().map { String(format: "%02x", $0) }.joined())
}

private func checkedMultiply(_ left: Int64, _ right: Int64) throws -> Int64 {
  let result = left.multipliedReportingOverflow(by: right)
  guard !result.overflow, result.partialValue >= 0 else {
    throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "导入大小计算溢出")
  }
  return result.partialValue
}

private func checkedAdd(_ left: Int64, _ right: Int64) throws -> Int64 {
  let result = left.addingReportingOverflow(right)
  guard !result.overflow, result.partialValue >= 0 else {
    throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "导入大小计算溢出")
  }
  return result.partialValue
}

private func scaledBytes(_ bytes: Int64, multiplier: Double) throws -> Int64 {
  let value = (Double(bytes) * multiplier).rounded(.up)
  guard value.isFinite, value >= 0, value <= Double(Int64.max) else {
    throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "导入大小计算溢出")
  }
  return Int64(value)
}

private func absolutePathComponents(_ path: String, code: String) throws -> [String] {
  guard path.hasPrefix("/"), !path.utf8.contains(0) else {
    throw SecureImportFailure(code, "受控路径必须是绝对路径")
  }
  let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
  guard !components.contains("."), !components.contains("..") else {
    throw SecureImportFailure(code, "受控路径不能包含相对路径段")
  }
  return components
}

private func openDirectoryChainWithoutSymlinks(
  _ path: String,
  failureCode: String = "IMPORT_DESTINATION_UNSAFE",
  failureMessage: String = "受控目录路径包含符号链接"
) throws -> Int32 {
  let components = try absolutePathComponents(path, code: failureCode)
  var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard descriptor >= 0 else {
    throw SecureImportFailure(failureCode, "无法验证受控目录")
  }
  for component in components {
    let next = openat(
      descriptor,
      component,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    Darwin.close(descriptor)
    guard next >= 0 else {
      throw SecureImportFailure(failureCode, failureMessage)
    }
    descriptor = next
  }
  return descriptor
}

private func assertPinnedDirectoryPath(
  _ path: String,
  descriptor: Int32,
  code: String,
  message: String
) throws {
  let currentFD: Int32
  do {
    currentFD = try openDirectoryChainWithoutSymlinks(
      path,
      failureCode: code,
      failureMessage: message
    )
  } catch {
    throw SecureImportFailure(code, message)
  }
  defer { Darwin.close(currentFD) }
  var expected = stat()
  var current = stat()
  guard fstat(descriptor, &expected) == 0,
    fstat(currentFD, &current) == 0,
    (expected.st_mode & S_IFMT) == S_IFDIR,
    expected.st_dev == current.st_dev,
    expected.st_ino == current.st_ino
  else {
    throw SecureImportFailure(code, message)
  }
}

private func assertPinnedChildDirectory(
  parentFD: Int32,
  name: String,
  childFD: Int32
) throws {
  var pathIdentity = stat()
  var pinnedIdentity = stat()
  guard fstatat(parentFD, name, &pathIdentity, AT_SYMLINK_NOFOLLOW) == 0,
    fstat(childFD, &pinnedIdentity) == 0,
    (pathIdentity.st_mode & S_IFMT) == S_IFDIR,
    pathIdentity.st_dev == pinnedIdentity.st_dev,
    pathIdentity.st_ino == pinnedIdentity.st_ino
  else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "受控导入子目录身份发生变化")
  }
}

private func assertPinnedDestinationDirectories(
  rootPath: String,
  rootFD: Int32,
  stagingFD: Int32,
  completeFD: Int32
) throws {
  try assertPinnedDirectoryPath(
    rootPath,
    descriptor: rootFD,
    code: "IMPORT_DESTINATION_UNSAFE",
    message: "导入目录祖先或身份发生变化"
  )
  try assertPinnedChildDirectory(parentFD: rootFD, name: "staging", childFD: stagingFD)
  try assertPinnedChildDirectory(parentFD: rootFD, name: "complete", childFD: completeFD)
}

private func assertUnchanged(source: PinnedSource, original: stat) throws {
  var final = stat()
  var pathIdentity = stat()
  try assertPinnedDirectoryPath(
    source.parentPath,
    descriptor: source.parentDescriptor,
    code: "IMPORT_SOURCE_CHANGED",
    message: "导入期间源文件祖先目录发生变化"
  )
  guard fstat(source.descriptor, &final) == 0,
    fstatat(source.parentDescriptor, source.name, &pathIdentity, AT_SYMLINK_NOFOLLOW) == 0,
    final.st_dev == original.st_dev, final.st_ino == original.st_ino,
    pathIdentity.st_dev == original.st_dev, pathIdentity.st_ino == original.st_ino,
    final.st_nlink == 1, pathIdentity.st_nlink == 1,
    final.st_size == original.st_size,
    final.st_mtimespec.tv_sec == original.st_mtimespec.tv_sec,
    final.st_mtimespec.tv_nsec == original.st_mtimespec.tv_nsec
  else {
    throw SecureImportFailure("IMPORT_SOURCE_CHANGED", "导入期间源文件发生变化")
  }
}

private func lexicalChildPath(_ parent: String, _ child: String) -> String {
  parent.hasSuffix("/") ? parent + child : parent + "/" + child
}

private func pathForDescriptor(_ descriptor: Int32) throws -> String {
  var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  guard fcntl(descriptor, F_GETPATH, &bytes) == 0 else {
    throw SecureImportFailure("IMPORT_DESTINATION_UNSAFE", "无法定位受控临时文件")
  }
  let end = bytes.firstIndex(of: 0) ?? bytes.endIndex
  return String(decoding: bytes[..<end].map { UInt8(bitPattern: $0) }, as: UTF8.self)
}

private func supportedMediaExtension(sourceFD: Int32) throws -> String {
  var bytes = [UInt8](repeating: 0, count: 64)
  let count = pread(sourceFD, &bytes, bytes.count, 0)
  guard count >= 4 else {
    throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "媒体数据被截断")
  }
  bytes.removeSubrange(count..<bytes.count)
  func ascii(_ range: Range<Int>) -> String {
    guard range.upperBound <= bytes.count else { return "" }
    return String(bytes: bytes[range], encoding: .ascii) ?? ""
  }
  if ascii(0..<4) == "RIFF", ascii(8..<12) == "WAVE" { return "wav" }
  if ascii(0..<4) == "caff" { return "caf" }
  if ascii(0..<4) == "FORM", ["AIFF", "AIFC"].contains(ascii(8..<12)) { return "aiff" }
  if bytes.count >= 2, bytes[0] == 0xff, (bytes[1] & 0xf6) == 0xf0 { return "aac" }
  if bytes.starts(with: [0x49, 0x44, 0x33])
    || (bytes.count >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
  { return "mp3" }
  if bytes.count >= 8, ascii(4..<8) == "ftyp" { return "m4a" }
  throw SecureImportFailure(
    "IMPORT_FORMAT_UNSUPPORTED",
    "仅支持可归一化的 WAV、AIFF、CAF、MP3、AAC、M4A、MOV 或 MP4 音轨"
  )
}

func normalizeToPCM16kMono(
  source: URL,
  destination: URL,
  maximumPCMBytes: Int64
) throws {
  let descriptor = Darwin.open(
    destination.path,
    O_RDWR | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC,
    S_IRUSR | S_IWUSR
  )
  guard descriptor >= 0 else {
    throw SecureImportFailure("IMPORT_STAGING_CREATE_FAILED", "无法创建 PCM 临时文件")
  }
  defer { Darwin.close(descriptor) }
  try normalizeToPCM16kMono(
    source: source,
    destinationFD: descriptor,
    maximumPCMBytes: maximumPCMBytes
  )
}

private func normalizeToPCM16kMono(
  source: URL,
  destinationFD: Int32,
  maximumPCMBytes: Int64
) throws {
  guard maximumPCMBytes > 0,
    ftruncate(destinationFD, 0) == 0,
    lseek(destinationFD, 0, SEEK_SET) == 0
  else {
    throw SecureImportFailure("IMPORT_ARGUMENTS_INVALID", "PCM 输出上限无效")
  }
  let asset = AVURLAsset(url: source)
  guard let track = asset.tracks(withMediaType: .audio).first else {
    throw SecureImportFailure("IMPORT_FORMAT_UNSUPPORTED", "媒体没有受支持的音轨")
  }
  let reader: AVAssetReader
  do { reader = try AVAssetReader(asset: asset) } catch {
    throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "无法读取媒体")
  }
  let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16_000,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
  )
  output.alwaysCopiesSampleData = false
  guard reader.canAdd(output) else {
    throw SecureImportFailure("IMPORT_FORMAT_UNSUPPORTED", "媒体格式无法归一化")
  }
  reader.add(output)
  let handle = FileHandle(fileDescriptor: destinationFD, closeOnDealloc: false)
  try handle.write(contentsOf: Data(repeating: 0, count: 44))
  guard reader.startReading() else {
    throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "媒体解码无法启动")
  }
  defer {
    if reader.status == .reading { reader.cancelReading() }
  }
  var dataSize: Int64 = 0
  while let sample = output.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { continue }
    let nextSize = try checkedAdd(dataSize, Int64(length))
    guard nextSize <= maximumPCMBytes, nextSize <= Int64(UInt32.max) else {
      reader.cancelReading()
      throw SecureImportFailure(
        "IMPORT_SOURCE_DURATION_INVALID",
        "解码 PCM 超过本地处理上限"
      )
    }
    var bytes = Data(count: length)
    let status = bytes.withUnsafeMutableBytes { pointer in
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: pointer.baseAddress!)
    }
    guard status == kCMBlockBufferNoErr else {
      throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "无法读取解码音频")
    }
    try handle.write(contentsOf: bytes)
    dataSize = nextSize
  }
  guard reader.status == .completed, dataSize > 0, dataSize <= Int64(UInt32.max) else {
    throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "媒体解码未完整完成")
  }
  try handle.synchronize()
  try handle.seek(toOffset: 0)
  try handle.write(contentsOf: waveHeader(dataSize: UInt32(dataSize)))
  try handle.synchronize()
}

private func waveHeader(dataSize: UInt32) -> Data {
  var data = Data()
  func ascii(_ value: String) { data.append(Data(value.utf8)) }
  func u16(_ value: UInt16) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }
  func u32(_ value: UInt32) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }
  ascii("RIFF"); u32(36 + dataSize); ascii("WAVEfmt "); u32(16); u16(1); u16(1)
  u32(16_000); u32(32_000); u16(2); u16(16); ascii("data"); u32(dataSize)
  return data
}

private func readExactly(
  descriptor: Int32,
  offset: Int64,
  count: Int
) throws -> Data {
  var data = Data(count: count)
  var total = 0
  while total < count {
    let readCount = data.withUnsafeMutableBytes { pointer in
      pread(
        descriptor,
        pointer.baseAddress!.advanced(by: total),
        count - total,
        off_t(offset + Int64(total))
      )
    }
    if readCount < 0 {
      if errno == EINTR { continue }
      throw SecureImportFailure("IMPORT_MEDIA_CORRUPT", "读取 WAVE 头失败")
    }
    guard readCount > 0 else {
      throw SecureImportFailure("IMPORT_MEDIA_TRUNCATED", "媒体数据被截断")
    }
    total += readCount
  }
  return data
}

private func ascii(_ data: Data, _ range: Range<Int>) -> String {
  guard range.lowerBound >= 0, range.upperBound <= data.count else { return "" }
  return String(data: data[range], encoding: .ascii) ?? ""
}

private func readUInt16(_ data: Data, _ offset: Int) -> UInt16 {
  UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
}

private func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
  UInt32(data[offset]) | (UInt32(data[offset + 1]) << 8)
    | (UInt32(data[offset + 2]) << 16) | (UInt32(data[offset + 3]) << 24)
}

private func syncDirectory(_ descriptor: Int32) throws {
  guard fsync(descriptor) == 0 else {
    throw SecureImportFailure("IMPORT_FSYNC_FAILED", "无法持久化导入目录")
  }
}

private func defaultAvailableCapacity(_ url: URL) throws -> Int64 {
  let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
  guard let value = values.volumeAvailableCapacityForImportantUsage else {
    throw SecureImportFailure("IMPORT_DISK_SPACE_LOW", "无法确认目标卷剩余空间")
  }
  return value
}
