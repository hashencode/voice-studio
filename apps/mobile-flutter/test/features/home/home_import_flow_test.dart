import 'package:flutter/material.dart';
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/home/home_page.dart';
import 'package:voice2text_flutter/features/home/model/folder_entity.dart';
import 'package:voice2text_flutter/features/home/repository/folders_repository.dart';
import 'package:voice2text_flutter/features/importing/model/import_candidate.dart';
import 'package:voice2text_flutter/features/importing/service/audio_import_service.dart';
import 'package:voice2text_flutter/features/recording/service/recording_startup_reconciler.dart';
import 'package:voice2text_flutter/features/records/model/recording_entity.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';

void main() {
  testWidgets('home import panel completes and reloads the shared repository', (
    WidgetTester tester,
  ) async {
    final recordings = _CountingRecordingsRepository();
    final importer = _SuccessfulImportService();
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: recordings,
          foldersRepository: _EmptyFoldersRepository(),
          recordingStartupReconciler: RecordingStartupReconciler(
            enabled: false,
          ),
          audioImportService: importer,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('导入'));
    await tester.pumpAndSettle();

    expect(importer.pickCalls, 1);
    expect(find.text('导入音频媒体'), findsOneWidget);
    expect(find.text('集成测试'), findsOneWidget);
    expect(find.text('.m4a'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);

    await tester.ensureVisible(find.text('完成'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();

    expect(find.text('导入音频媒体'), findsNothing);
    expect(recordings.listCalls, greaterThanOrEqualTo(2));
  });

  testWidgets('home consumes a pending system share and refreshes the list', (
    WidgetTester tester,
  ) async {
    final recordings = _CountingRecordingsRepository();
    final importer = _SuccessfulSharedImportService();
    addTearDown(importer.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: recordings,
          foldersRepository: _EmptyFoldersRepository(),
          recordingStartupReconciler: RecordingStartupReconciler(
            enabled: false,
          ),
          audioImportService: importer,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(importer.consumeCalls, 1);
    expect(recordings.listCalls, greaterThanOrEqualTo(2));
  });

  testWidgets('stale initial load cannot overwrite a completed shared import', (
    WidgetTester tester,
  ) async {
    final recordings = _OutOfOrderRecordingsRepository();
    final importer = _SuccessfulSharedImportService();
    addTearDown(importer.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: recordings,
          foldersRepository: _EmptyFoldersRepository(),
          recordingStartupReconciler: RecordingStartupReconciler(
            enabled: false,
          ),
          audioImportService: importer,
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('系统分享.m4a'), findsOneWidget);

    recordings.completeInitialLoad();
    await tester.pumpAndSettle();

    expect(find.text('系统分享.m4a'), findsOneWidget);
  });
}

class _SuccessfulImportService extends AudioImportService {
  int pickCalls = 0;

  @override
  Future<AudioImportOutcome?> pickAndImport() async {
    pickCalls += 1;
    return const AudioImportOutcome(
      candidate: ImportCandidate(
        path: '/data/user/0/app/files/audios/imports/complete/integration.m4a',
        displayName: '集成测试.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 4096,
        durationMs: 12_000,
        fingerprintSha256: 'home-import-flow',
        duplicateAsset: false,
      ),
      recordingId: 7,
      inserted: true,
      transcriptionJobId: 11,
    );
  }
}

class _SuccessfulSharedImportService extends AudioImportService {
  final StreamController<void> _available = StreamController<void>.broadcast();
  int consumeCalls = 0;

  @override
  Stream<void> get sharedMediaAvailable => _available.stream;

  @override
  Future<bool> hasPendingSharedImport() async => consumeCalls == 0;

  @override
  Future<AudioImportOutcome?> consumeSharedImport() async {
    consumeCalls += 1;
    if (consumeCalls > 1) return null;
    return const AudioImportOutcome(
      candidate: ImportCandidate(
        path: '/data/user/0/app/files/audios/imports/complete/shared.m4a',
        displayName: '系统分享.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 4096,
        durationMs: 12_000,
        fingerprintSha256: 'home-system-share',
        duplicateAsset: false,
      ),
      recordingId: 8,
      inserted: true,
      transcriptionJobId: 12,
    );
  }

  @override
  void dispose() {
    _available.close();
    super.dispose();
  }
}

class _CountingRecordingsRepository extends RecordingsRepository {
  int listCalls = 0;

  @override
  Future<List<RecordingEntity>> listActive({String? groupName}) async {
    listCalls += 1;
    return const <RecordingEntity>[];
  }

  @override
  Future<List<RecordingEntity>> listDeleted() async {
    listCalls += 1;
    return const <RecordingEntity>[];
  }
}

class _OutOfOrderRecordingsRepository extends RecordingsRepository {
  final Completer<List<RecordingEntity>> _initialLoad =
      Completer<List<RecordingEntity>>();
  int _listCalls = 0;

  @override
  Future<List<RecordingEntity>> listActive({String? groupName}) {
    _listCalls += 1;
    if (_listCalls == 1) return _initialLoad.future;
    return Future<List<RecordingEntity>>.value(<RecordingEntity>[
      RecordingEntity(
        id: 8,
        filePath: '/data/user/0/app/files/audios/imports/complete/shared.m4a',
        displayName: '系统分享.m4a',
        groupName: null,
        deletedAtMs: null,
        isFavorite: false,
        durationMs: 12_000,
        createdAtMs: 1,
      ),
    ]);
  }

  @override
  Future<List<RecordingEntity>> listDeleted() async =>
      const <RecordingEntity>[];

  void completeInitialLoad() {
    _initialLoad.complete(const <RecordingEntity>[]);
  }
}

class _EmptyFoldersRepository extends FoldersRepository {
  @override
  Future<List<FolderEntity>> listFolders() async {
    return const <FolderEntity>[];
  }
}
