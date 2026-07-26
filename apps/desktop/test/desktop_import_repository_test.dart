import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/importing/desktop_import_service.dart';
import 'package:voice2text_desktop/features/importing/import_transfer_port.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_engine.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test(
    'supported file is privately copied, hashed, persisted and queued',
    () async {
      final fixture = await _openFixture();
      addTearDown(fixture.dispose);
      final source = await _sourceFile(fixture.root, 'meeting.wav');
      final transfer = _LocalTestTransferPort();
      final service = _service(fixture, transfer);

      final outcome = await service.importSelectedPath(
        sourcePath: source.path,
        displayName: '项目周会.wav',
      );

      expect(outcome.inserted, isTrue);
      expect(outcome.processingJobId, isNotNull);
      final jobs = await fixture.repository.listJobs();
      expect(jobs, hasLength(1));
      expect(jobs.single.state, DesktopJobState.pending);
      expect(
        jobs.single.fingerprintSha256,
        sha256.convert(await source.readAsBytes()).toString(),
      );
      expect(jobs.single.recordingPath, isNot(source.path));
      expect(
        await File(jobs.single.recordingPath).readAsBytes(),
        await source.readAsBytes(),
      );
    },
  );

  test(
    'same content is idempotent and the alternate private copy is removed',
    () async {
      final fixture = await _openFixture();
      addTearDown(fixture.dispose);
      final source = await _sourceFile(fixture.root, 'meeting.wav');
      final transfer = _LocalTestTransferPort();
      final service = _service(fixture, transfer);

      final first = await service.importSelectedPath(
        sourcePath: source.path,
        displayName: '第一次.wav',
      );
      final second = await service.importSelectedPath(
        sourcePath: source.path,
        displayName: '第二次.wav',
      );

      expect(first.inserted, isTrue);
      expect(second.inserted, isFalse);
      expect(second.recordingId, first.recordingId);
      expect(await fixture.repository.listJobs(), hasLength(1));
      expect(transfer.discardedPaths, hasLength(1));
      expect(File(transfer.discardedPaths.single).existsSync(), isFalse);
    },
  );

  for (final failure in const <DesktopImportFailure>[
    DesktopImportFailure('IMPORT_DISK_SPACE_LOW', '目标卷空间不足'),
    DesktopImportFailure('IMPORT_CANCELED', '导入已取消'),
    DesktopImportFailure('IMPORT_SOURCE_UNREADABLE', '没有权限读取所选文件'),
    DesktopImportFailure('IMPORT_MEDIA_CORRUPT', '文件损坏'),
  ]) {
    test('${failure.code} never creates a half-committed recording', () async {
      final fixture = await _openFixture();
      addTearDown(fixture.dispose);
      final source = await _sourceFile(fixture.root, 'meeting.wav');
      final service = _service(fixture, _FailingTransferPort(failure));

      await expectLater(
        service.importSelectedPath(
          sourcePath: source.path,
          displayName: '失败会议.wav',
        ),
        throwsA(
          isA<DesktopImportFailure>().having(
            (value) => value.code,
            'code',
            failure.code,
          ),
        ),
      );

      expect(await fixture.repository.listJobs(), isEmpty);
      final database = await fixture.database.database;
      expect(await database.query('recordings'), isEmpty);
    });
  }

  test(
    'restart marks an interrupted processing job explicitly failed',
    () async {
      final fixture = await _openFixture();
      final source = await _sourceFile(fixture.root, 'meeting.wav');
      final service = _service(fixture, _LocalTestTransferPort());
      await service.importSelectedPath(
        sourcePath: source.path,
        displayName: '中断会议.wav',
      );
      final claimed = await fixture.repository.claimNext();
      expect(claimed?.state, DesktopJobState.processing);
      await (await fixture.database.database).close();

      final reopenedDatabase = AppDatabase(
        factory: databaseFactoryFfi,
        databasePathProvider: () async => fixture.databaseDirectory.path,
        databaseName: 'desktop-test.db',
      );
      final reopenedRepository = DesktopProcessingRepository(
        database: reopenedDatabase,
      );
      expect(await reopenedRepository.reconcileInterruptedJobs(), 1);
      final jobs = await reopenedRepository.listJobs();
      expect(jobs.single.state, DesktopJobState.failed);
      expect(jobs.single.errorCode, 'PROCESS_INTERRUPTED');

      await (await reopenedDatabase.database).close();
      await fixture.root.delete(recursive: true);
    },
  );

  test('import preflight receives the frozen operational envelope', () async {
    final fixture = await _openFixture();
    addTearDown(fixture.dispose);
    final source = await _sourceFile(fixture.root, 'meeting.wav');
    final transfer = _EnvelopeCapturingPort();
    const envelope = ProcessingOperationalEnvelope(
      maxSourceBytes: 1024,
      maxDurationSeconds: 60,
      maxDecodedPcmBytes: 2048,
      maxSegments: 10,
      maxQueuedJobs: 1,
      maxConcurrentEngines: 1,
      temporaryStorageMultiplier: 3,
      minimumFreeBytesAfterImport: 4096,
    );
    final service = DesktopImportService(
      transferPort: transfer,
      repository: fixture.repository,
      importRootProvider: () async => fixture.importDirectory,
      envelope: envelope,
    );

    await expectLater(
      service.importSelectedPath(
        sourcePath: source.path,
        displayName: 'preflight.wav',
      ),
      throwsA(isA<DesktopImportFailure>()),
    );

    expect(transfer.request?.maxSourceBytes, envelope.maxSourceBytes);
    expect(
      transfer.request?.minimumFreeBytes,
      envelope.minimumFreeBytesAfterImport,
    );
    expect(
      transfer.request?.temporaryStorageMultiplier,
      envelope.temporaryStorageMultiplier,
    );
    expect(transfer.request?.maxDurationMs, envelope.maxDurationSeconds * 1000);
    expect(await fixture.repository.listJobs(), isEmpty);
    expect(fixture.importDirectory.existsSync(), isTrue);
    expect(fixture.importDirectory.listSync(), isEmpty);
  });

  test('queue envelope rejects before transfer or staging write', () async {
    final fixture = await _openFixture();
    addTearDown(fixture.dispose);
    final first = await _sourceFile(fixture.root, 'first.wav');
    final second = await _sourceFile(fixture.root, 'second.wav');
    await _service(
      fixture,
      _LocalTestTransferPort(),
    ).importSelectedPath(sourcePath: first.path, displayName: 'first.wav');
    final transfer = _CountingTransferPort();
    final service = DesktopImportService(
      transferPort: transfer,
      repository: fixture.repository,
      importRootProvider: () async =>
          Directory(p.join(fixture.root.path, 'should-not-exist')),
      envelope: const ProcessingOperationalEnvelope(
        maxSourceBytes: 1024 * 1024,
        maxDurationSeconds: 60,
        maxDecodedPcmBytes: 1024 * 1024,
        maxSegments: 10,
        maxQueuedJobs: 1,
        maxConcurrentEngines: 1,
        temporaryStorageMultiplier: 2,
        minimumFreeBytesAfterImport: 1024,
      ),
    );

    await expectLater(
      service.importSelectedPath(
        sourcePath: second.path,
        displayName: 'second.wav',
      ),
      throwsA(
        isA<DesktopImportFailure>().having(
          (failure) => failure.code,
          'code',
          'PROCESSING_QUEUE_FULL',
        ),
      ),
    );
    expect(transfer.transferCalls, 0);
    expect(
      Directory(p.join(fixture.root.path, 'should-not-exist')).existsSync(),
      isFalse,
    );
  });

  test(
    'a fake engine is test-only and can validate queue completion',
    () async {
      final fixture = await _openFixture();
      addTearDown(fixture.dispose);
      final source = await _sourceFile(fixture.root, 'meeting.wav');
      await _service(
        fixture,
        _LocalTestTransferPort(),
      ).importSelectedPath(sourcePath: source.path, displayName: '测试会议.wav');
      final engine = _FakeTestEngine();
      final coordinator = DesktopProcessingCoordinator(
        repository: fixture.repository,
        engine: engine,
      );

      expect(await coordinator.processNext(), isTrue);

      expect(engine.processedJobIds, <int>[1]);
      expect(
        (await fixture.repository.listJobs()).single.state,
        DesktopJobState.completed,
      );
    },
  );
}

DesktopImportService _service(
  _Fixture fixture,
  DesktopImportTransferPort transfer,
) {
  return DesktopImportService(
    transferPort: transfer,
    repository: fixture.repository,
    importRootProvider: () async => fixture.importDirectory,
  );
}

Future<File> _sourceFile(Directory root, String name) async {
  final file = File(p.join(root.path, name));
  await file.writeAsBytes(<int>[
    ...'RIFF'.codeUnits,
    0,
    0,
    0,
    0,
    ...'WAVE'.codeUnits,
    ...List<int>.generate(4096, (index) => index % 251),
  ]);
  return file;
}

Future<_Fixture> _openFixture() async {
  final root = await Directory.systemTemp.createTemp('desktop-import-test-');
  final databaseDirectory = Directory(p.join(root.path, 'database'));
  await databaseDirectory.create();
  final database = AppDatabase(
    factory: databaseFactoryFfi,
    databasePathProvider: () async => databaseDirectory.path,
    databaseName: 'desktop-test.db',
  );
  return _Fixture(
    root: root,
    databaseDirectory: databaseDirectory,
    importDirectory: Directory(p.join(root.path, 'imports')),
    database: database,
    repository: DesktopProcessingRepository(database: database),
  );
}

class _Fixture {
  const _Fixture({
    required this.root,
    required this.databaseDirectory,
    required this.importDirectory,
    required this.database,
    required this.repository,
  });

  final Directory root;
  final Directory databaseDirectory;
  final Directory importDirectory;
  final AppDatabase database;
  final DesktopProcessingRepository repository;

  Future<void> dispose() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  }
}

class _LocalTestTransferPort implements DesktopImportTransferPort {
  final List<String> discardedPaths = <String>[];

  @override
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  ) async {
    final bytes = await File(request.sourcePath).readAsBytes();
    final complete = Directory(p.join(request.destinationRoot, 'complete'));
    await complete.create(recursive: true);
    final destination = File(
      p.join(complete.path, '${request.destinationId}.wav'),
    );
    await destination.writeAsBytes(bytes, flush: true);
    return DesktopImportTransferResult(
      path: destination.path,
      sizeBytes: bytes.length,
      fingerprintSha256: sha256.convert(bytes).toString(),
      mediaType: 'audio',
      durationMs: 1000,
    );
  }

  @override
  Future<void> cancel() async {}

  @override
  Future<void> discard(String committedPath) async {
    discardedPaths.add(committedPath);
    await File(committedPath).delete();
  }
}

class _EnvelopeCapturingPort implements DesktopImportTransferPort {
  DesktopImportTransferRequest? request;

  @override
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  ) async {
    this.request = request;
    throw const DesktopImportFailure(
      'IMPORT_SOURCE_SIZE_INVALID',
      'preflight rejected',
    );
  }

  @override
  Future<void> cancel() async {}

  @override
  Future<void> discard(String committedPath) async {}
}

class _CountingTransferPort implements DesktopImportTransferPort {
  int transferCalls = 0;

  @override
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  ) {
    transferCalls += 1;
    throw StateError('transfer must not be called');
  }

  @override
  Future<void> cancel() async {}

  @override
  Future<void> discard(String committedPath) async {}
}

class _FailingTransferPort implements DesktopImportTransferPort {
  const _FailingTransferPort(this.failure);

  final DesktopImportFailure failure;

  @override
  Future<DesktopImportTransferResult> transfer(
    DesktopImportTransferRequest request,
  ) async => throw failure;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> discard(String committedPath) async {}
}

class _FakeTestEngine implements DesktopProcessingEngine {
  final List<int> processedJobIds = <int>[];

  @override
  bool get isAvailable => true;

  @override
  String get availabilityMessage => 'test-only';

  @override
  Future<DesktopProcessingResult> process(
    DesktopProcessingJob job, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    processedJobIds.add(job.id);
    return const DesktopProcessingResult(
      segments: <ProcessingTranscriptSegment>[
        ProcessingTranscriptSegment(
          startSeconds: 0,
          endSeconds: 1,
          text: '测试',
          speakerAssignment: SpeakerAssignment.unknown,
        ),
      ],
      engineId: 'test-only',
      elapsedMilliseconds: 1,
      peakResidentBytes: 1,
      diarizationSucceeded: false,
      diarizationErrorCode: 'DIARIZATION_FAILED',
    );
  }
}
