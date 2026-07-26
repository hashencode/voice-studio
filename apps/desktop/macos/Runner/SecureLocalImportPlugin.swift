import AVFoundation
import CryptoKit
import Darwin
import FlutterMacOS
import Foundation

final class SecureLocalImportPlugin {
  private let channel: FlutterMethodChannel
  private let queue = DispatchQueue(
    label: "com.voice2text.desktop.secure-local-import",
    qos: .userInitiated
  )
  private let stateLock = NSLock()
  private var canceled = false
  private var importRunning = false
  private var allowedRoots = Set<String>()

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(
      name: "com.voice2text.desktop/secure_local_import",
      binaryMessenger: messenger
    )
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "commitLocalMeetingFile":
      guard let arguments = call.arguments as? [String: Any] else {
        result(error("IMPORT_ARGUMENTS_INVALID", "导入参数无效"))
        return
      }
      stateLock.lock()
      guard !importRunning else {
        stateLock.unlock()
        result(error("IMPORT_ALREADY_RUNNING", "已有文件正在导入"))
        return
      }
      importRunning = true
      canceled = false
      stateLock.unlock()
      queue.async { [weak self] in
        guard let self else { return }
        do {
          let value = try self.commit(arguments)
          self.finish(result, value)
        } catch let failure as ImportFailure {
          self.finish(result, self.error(failure.code, failure.message))
        } catch {
          self.finish(result, self.error("IMPORT_IO_FAILED", "复制会议文件失败"))
        }
      }
    case "cancelLocalMeetingImport":
      stateLock.lock()
      canceled = true
      stateLock.unlock()
      result(nil)
    case "discardLocalMeetingFile":
      guard
        let arguments = call.arguments as? [String: Any],
        let path = arguments["path"] as? String
      else {
        result(error("IMPORT_ARGUMENTS_INVALID", "清理参数无效"))
        return
      }
      do {
        try discard(path)
        result(nil)
      } catch let failure as ImportFailure {
        result(error(failure.code, failure.message))
      } catch {
        result(self.error("IMPORT_DISCARD_FAILED", "无法清理重复导入文件"))
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func finish(_ result: @escaping FlutterResult, _ value: Any?) {
    stateLock.lock()
    importRunning = false
    canceled = false
    stateLock.unlock()
    DispatchQueue.main.async {
      result(value)
    }
  }

  private func commit(_ arguments: [String: Any]) throws -> [String: Any] {
    guard
      let sourcePath = arguments["sourcePath"] as? String,
      let destinationRootPath = arguments["destinationRoot"] as? String,
      let destinationId = arguments["destinationId"] as? String,
      let maxSourceBytes = (arguments["maxSourceBytes"] as? NSNumber)?.int64Value,
      let minimumFreeBytes = (arguments["minimumFreeBytes"] as? NSNumber)?.int64Value,
      let temporaryStorageMultiplier =
        (arguments["temporaryStorageMultiplier"] as? NSNumber)?.doubleValue,
      let maxDurationMs = (arguments["maxDurationMs"] as? NSNumber)?.int64Value,
      destinationId.range(of: #"^meeting-[a-zA-Z0-9-]{12,120}$"#, options: .regularExpression) != nil,
      maxSourceBytes > 0,
      minimumFreeBytes >= 0,
      temporaryStorageMultiplier >= 1.0,
      temporaryStorageMultiplier <= 8.0,
      maxDurationMs > 0
    else {
      throw ImportFailure("IMPORT_ARGUMENTS_INVALID", "导入参数无效")
    }

    let fileManager = FileManager.default
    let rootURL = URL(fileURLWithPath: destinationRootPath, isDirectory: true)
      .standardizedFileURL
    try fileManager.createDirectory(
      at: rootURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let canonicalRoot = rootURL.resolvingSymlinksInPath()
    guard canonicalRoot.path == rootURL.path else {
      throw ImportFailure("IMPORT_DESTINATION_UNSAFE", "导入目录不能经过符号链接")
    }
    let stagingURL = canonicalRoot.appendingPathComponent("staging", isDirectory: true)
    let completeURL = canonicalRoot.appendingPathComponent("complete", isDirectory: true)
    for directory in [stagingURL, completeURL] {
      try fileManager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      guard
        directory.resolvingSymlinksInPath().path.hasPrefix(canonicalRoot.path + "/")
      else {
        throw ImportFailure("IMPORT_DESTINATION_UNSAFE", "导入目录越过了受控边界")
      }
    }

    let sourceURL = URL(fileURLWithPath: sourcePath)
    let securityScoped = sourceURL.startAccessingSecurityScopedResource()
    defer {
      if securityScoped {
        sourceURL.stopAccessingSecurityScopedResource()
      }
    }

    let sourceFD = Darwin.open(sourcePath, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard sourceFD >= 0 else {
      if errno == ELOOP {
        throw ImportFailure("IMPORT_SOURCE_LINK_REJECTED", "不接受符号链接来源")
      }
      throw ImportFailure("IMPORT_SOURCE_UNREADABLE", "没有权限读取所选文件")
    }
    defer { Darwin.close(sourceFD) }

    var sourceStat = stat()
    guard fstat(sourceFD, &sourceStat) == 0 else {
      throw ImportFailure("IMPORT_SOURCE_UNREADABLE", "无法读取文件身份")
    }
    guard (sourceStat.st_mode & S_IFMT) == S_IFREG else {
      throw ImportFailure("IMPORT_SOURCE_NOT_REGULAR", "只接受普通文件")
    }
    guard sourceStat.st_nlink == 1 else {
      throw ImportFailure("IMPORT_SOURCE_LINK_REJECTED", "不接受硬链接来源")
    }
    guard sourceStat.st_size > 0, sourceStat.st_size <= maxSourceBytes else {
      throw ImportFailure("IMPORT_SOURCE_SIZE_INVALID", "文件为空或超过导入上限")
    }
    if sourceStat.st_size > 4096 && sourceStat.st_blocks * 512 < sourceStat.st_size {
      throw ImportFailure("IMPORT_SOURCE_SPARSE_REJECTED", "不接受稀疏文件")
    }

    let resourceValues = try canonicalRoot.resourceValues(
      forKeys: [.volumeAvailableCapacityForImportantUsageKey]
    )
    guard
      let available = resourceValues.volumeAvailableCapacityForImportantUsage,
      available >= Int64(
        ceil(Double(sourceStat.st_size) * temporaryStorageMultiplier)
      ) + minimumFreeBytes
    else {
      throw ImportFailure("IMPORT_DISK_SPACE_LOW", "目标卷空间不足")
    }

    let stagingPath = stagingURL.appendingPathComponent(destinationId + ".partial").path
    let stagingFD = Darwin.open(
      stagingPath,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      S_IRUSR | S_IWUSR
    )
    guard stagingFD >= 0 else {
      throw ImportFailure("IMPORT_STAGING_CREATE_FAILED", "无法创建受控临时文件")
    }
    var stagingOpen = true
    var committedPath: String?
    defer {
      if stagingOpen {
        Darwin.close(stagingFD)
      }
      if committedPath == nil {
        try? fileManager.removeItem(atPath: stagingPath)
      }
    }

    var hasher = SHA256()
    var header = Data()
    var total: Int64 = 0
    let bufferSize = 1024 * 1024
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { buffer.deallocate() }

    while true {
      if isCanceled {
        throw ImportFailure("IMPORT_CANCELED", "导入已取消")
      }
      let readCount = Darwin.read(sourceFD, buffer, bufferSize)
      if readCount < 0 {
        if errno == EINTR { continue }
        throw ImportFailure("IMPORT_SOURCE_READ_FAILED", "读取所选文件失败")
      }
      if readCount == 0 { break }
      total += Int64(readCount)
      guard total <= sourceStat.st_size, total <= maxSourceBytes else {
        throw ImportFailure("IMPORT_SOURCE_CHANGED", "导入期间文件大小发生变化")
      }
      let chunk = Data(bytes: buffer, count: readCount)
      if header.count < 64 {
        header.append(chunk.prefix(64 - header.count))
      }
      hasher.update(data: chunk)
      var offset = 0
      while offset < readCount {
        let written = Darwin.write(stagingFD, buffer.advanced(by: offset), readCount - offset)
        if written < 0 {
          if errno == EINTR { continue }
          if errno == ENOSPC {
            throw ImportFailure("IMPORT_DISK_SPACE_LOW", "复制期间目标卷空间不足")
          }
          throw ImportFailure("IMPORT_DESTINATION_WRITE_FAILED", "写入受控文件失败")
        }
        offset += written
      }
    }
    guard total == sourceStat.st_size else {
      throw ImportFailure("IMPORT_SOURCE_CHANGED", "导入期间文件大小发生变化")
    }

    var finalSourceStat = stat()
    guard
      fstat(sourceFD, &finalSourceStat) == 0,
      finalSourceStat.st_dev == sourceStat.st_dev,
      finalSourceStat.st_ino == sourceStat.st_ino,
      finalSourceStat.st_size == sourceStat.st_size,
      finalSourceStat.st_mtimespec.tv_sec == sourceStat.st_mtimespec.tv_sec,
      finalSourceStat.st_mtimespec.tv_nsec == sourceStat.st_mtimespec.tv_nsec
    else {
      throw ImportFailure("IMPORT_SOURCE_CHANGED", "导入期间源文件发生变化")
    }

    let format = try probeFormat(header)
    guard fsync(stagingFD) == 0 else {
      throw ImportFailure("IMPORT_FSYNC_FAILED", "无法持久化导入文件")
    }
    guard Darwin.close(stagingFD) == 0 else {
      throw ImportFailure("IMPORT_FSYNC_FAILED", "无法关闭导入文件")
    }
    stagingOpen = false

    let finalURL = completeURL.appendingPathComponent(
      destinationId + "." + format.fileExtension
    )
    guard
      finalURL.standardizedFileURL.path.hasPrefix(completeURL.path + "/"),
      !fileManager.fileExists(atPath: finalURL.path)
    else {
      throw ImportFailure("IMPORT_DESTINATION_UNSAFE", "目标文件名发生冲突")
    }
    guard rename(stagingPath, finalURL.path) == 0 else {
      throw ImportFailure("IMPORT_ATOMIC_COMMIT_FAILED", "无法原子提交导入文件")
    }
    let asset = AVURLAsset(url: finalURL)
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite, durationSeconds > 0 else {
      try? fileManager.removeItem(at: finalURL)
      throw ImportFailure("IMPORT_MEDIA_CORRUPT", "无法读取媒体时长，文件可能已损坏")
    }
    guard durationSeconds * 1000 <= Double(maxDurationMs) else {
      try? fileManager.removeItem(at: finalURL)
      throw ImportFailure("IMPORT_SOURCE_DURATION_INVALID", "会议时长超过本地处理上限")
    }
    committedPath = finalURL.path
    let directoryFD = Darwin.open(completeURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    if directoryFD >= 0 {
      _ = fsync(directoryFD)
      Darwin.close(directoryFD)
    }

    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    stateLock.lock()
    allowedRoots.insert(canonicalRoot.path)
    stateLock.unlock()
    return [
      "path": finalURL.path,
      "sizeBytes": total,
      "fingerprintSha256": digest,
      "mediaType": format.mediaType,
      "durationMs": Int64((durationSeconds * 1000).rounded()),
    ]
  }

  private func discard(_ path: String) throws {
    let target = URL(fileURLWithPath: path).standardizedFileURL
    stateLock.lock()
    let roots = allowedRoots
    stateLock.unlock()
    guard roots.contains(where: { target.path.hasPrefix($0 + "/complete/") }) else {
      throw ImportFailure("IMPORT_DISCARD_OUTSIDE_ROOT", "拒绝清理受控目录之外的文件")
    }
    var targetStat = stat()
    guard lstat(target.path, &targetStat) == 0 else {
      if errno == ENOENT { return }
      throw ImportFailure("IMPORT_DISCARD_FAILED", "无法检查重复导入文件")
    }
    guard (targetStat.st_mode & S_IFMT) == S_IFREG else {
      throw ImportFailure("IMPORT_DISCARD_OUTSIDE_ROOT", "只允许清理受控普通文件")
    }
    try FileManager.default.removeItem(at: target)
  }

  private func probeFormat(_ header: Data) throws -> MediaFormat {
    let bytes = [UInt8](header)
    if bytes.count >= 12,
      String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
      String(bytes: bytes[8..<12], encoding: .ascii) == "WAVE"
    {
      return MediaFormat("audio", "wav")
    }
    if bytes.starts(with: [0x66, 0x4c, 0x61, 0x43]) {
      return MediaFormat("audio", "flac")
    }
    if bytes.starts(with: [0x4f, 0x67, 0x67, 0x53]) {
      return MediaFormat("audio", "ogg")
    }
    if bytes.starts(with: [0x49, 0x44, 0x33])
      || (bytes.count >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
    {
      return MediaFormat("audio", "mp3")
    }
    if bytes.count >= 8, String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp" {
      let brand = bytes.count >= 12 ? String(bytes: bytes[8..<12], encoding: .ascii) ?? "" : ""
      return brand.lowercased().contains("m4a")
        ? MediaFormat("audio", "m4a")
        : MediaFormat("video", "mp4")
    }
    if bytes.starts(with: [0x1a, 0x45, 0xdf, 0xa3]) {
      return MediaFormat("video", "mkv")
    }
    throw ImportFailure("IMPORT_FORMAT_UNSUPPORTED", "文件内容不是受支持的音视频格式")
  }

  private var isCanceled: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return canceled
  }

  private func error(_ code: String, _ message: String) -> FlutterError {
    FlutterError(code: code, message: message, details: nil)
  }
}

private struct MediaFormat {
  init(_ mediaType: String, _ fileExtension: String) {
    self.mediaType = mediaType
    self.fileExtension = fileExtension
  }

  let mediaType: String
  let fileExtension: String
}

private struct ImportFailure: Error {
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }

  let code: String
  let message: String
}
