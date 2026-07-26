import 'dart:io';
import 'dart:math';

import 'package:file_selector/file_selector.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';

import '../processing/desktop_processing_repository.dart';
import 'import_transfer_port.dart';

typedef ImportRootProvider = Future<Directory> Function();
typedef MeetingFilePicker = Future<XFile?> Function();

class DesktopImportOutcome {
  const DesktopImportOutcome({
    required this.recordingId,
    required this.inserted,
    this.processingJobId,
  });

  final int recordingId;
  final bool inserted;
  final int? processingJobId;
}

class DesktopImportService {
  DesktopImportService({
    required DesktopImportTransferPort transferPort,
    required DesktopProcessingRepository repository,
    required ImportRootProvider importRootProvider,
    MeetingFilePicker? filePicker,
    Random? secureRandom,
    this.envelope = ProcessingOperationalEnvelope.desktopV1,
  }) : _transferPort = transferPort,
       _repository = repository,
       _importRootProvider = importRootProvider,
       _filePicker = filePicker ?? _pickMeetingFile,
       _secureRandom = secureRandom ?? Random.secure();

  final DesktopImportTransferPort _transferPort;
  final DesktopProcessingRepository _repository;
  final ImportRootProvider _importRootProvider;
  final MeetingFilePicker _filePicker;
  final Random _secureRandom;
  final ProcessingOperationalEnvelope envelope;

  Future<DesktopImportOutcome?> pickAndImport() async {
    final file = await _filePicker();
    if (file == null) return null;
    return importSelectedPath(sourcePath: file.path, displayName: file.name);
  }

  Future<DesktopImportOutcome> importSelectedPath({
    required String sourcePath,
    required String displayName,
  }) async {
    if (sourcePath.trim().isEmpty) {
      throw const DesktopImportFailure('IMPORT_SOURCE_INVALID', '未选择有效的会议文件');
    }
    if (await _repository.countActiveJobs() >= envelope.maxQueuedJobs) {
      throw const DesktopImportFailure(
        'PROCESSING_QUEUE_FULL',
        '本地处理队列已满，请等待现有任务完成后重试',
      );
    }
    final root = await _importRootProvider();
    await root.create(recursive: true);
    final safeDisplayName = _boundedDisplayName(displayName);
    final transfer = await _transferPort.transfer(
      DesktopImportTransferRequest(
        sourcePath: sourcePath,
        destinationRoot: root.path,
        destinationId: _nextDestinationId(),
        displayName: safeDisplayName,
        maxSourceBytes: envelope.maxSourceBytes,
        minimumFreeBytes: envelope.minimumFreeBytesAfterImport,
        temporaryStorageMultiplier: envelope.temporaryStorageMultiplier,
        maxDurationMs: envelope.maxDurationSeconds * 1000,
      ),
    );
    final candidate = MeetingMediaCandidate(
      path: transfer.path,
      displayName: safeDisplayName,
      sizeBytes: transfer.sizeBytes,
      durationMs: transfer.durationMs,
      fingerprintSha256: transfer.fingerprintSha256,
      duplicateAsset: false,
    );
    try {
      final commit = await _repository.commitImported(candidate);
      if (!commit.inserted && transfer.path != commit.existingPath) {
        await _transferPort.discard(transfer.path);
      }
      return DesktopImportOutcome(
        recordingId: commit.recordingId,
        inserted: commit.inserted,
        processingJobId: commit.processingJob?.id,
      );
    } catch (_) {
      await _transferPort.discard(transfer.path);
      rethrow;
    }
  }

  Future<void> cancel() => _transferPort.cancel();

  String _nextDestinationId() {
    final entropy = List<int>.generate(12, (_) => _secureRandom.nextInt(256));
    final suffix = entropy
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return 'meeting-${DateTime.now().microsecondsSinceEpoch}-$suffix';
  }

  static String _boundedDisplayName(String raw) {
    final basename = p.basename(raw).replaceAll(RegExp(r'[\u0000-\u001f]'), '');
    final normalized = basename.trim().isEmpty ? '未命名会议' : basename.trim();
    final runes = normalized.runes.take(160).toList(growable: false);
    return String.fromCharCodes(runes);
  }

  static Future<XFile?> _pickMeetingFile() {
    const typeGroup = XTypeGroup(
      label: '会议音视频',
      extensions: <String>[
        'aac',
        'flac',
        'm4a',
        'mkv',
        'mov',
        'mp3',
        'mp4',
        'ogg',
        'wav',
        'webm',
      ],
    );
    return openFile(acceptedTypeGroups: const <XTypeGroup>[typeGroup]);
  }
}
