import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/home/home_page.dart';
import 'package:voice2text_flutter/features/home/model/folder_entity.dart';
import 'package:voice2text_flutter/features/home/repository/folders_repository.dart';
import 'package:voice2text_flutter/features/recording/service/recording_startup_reconciler.dart';
import 'package:voice2text_flutter/features/records/model/recording_entity.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';

void main() {
  testWidgets('home restores every persisted transcription lifecycle state', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final recordings = List<RecordingEntity>.generate(
      5,
      (int index) => RecordingEntity(
        id: index + 1,
        filePath: '/meetings/${index + 1}.m4a',
        displayName: '会议 ${index + 1}',
        groupName: null,
        deletedAtMs: null,
        isFavorite: false,
        durationMs: 60_000,
        createdAtMs: 1_750_000_000_000 + index,
      ),
    );
    final jobs = <String, TranscriptionJobEntity>{
      recordings[0].filePath: _job(recordings[0], 'pending'),
      recordings[1].filePath: _job(recordings[1], 'processing', progress: 0.42),
      recordings[2].filePath: _job(recordings[2], 'failed'),
      recordings[3].filePath: _job(recordings[3], 'completed'),
    };

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: _MemoryRecordingsRepository(recordings),
          foldersRepository: _EmptyFoldersRepository(),
          transcriptionJobsRepository: _MemoryJobsRepository(jobs),
          recordingStartupReconciler: RecordingStartupReconciler(
            enabled: false,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('待转写'), findsOneWidget);
    expect(find.textContaining('转写中 42%'), findsOneWidget);
    expect(find.textContaining('转写失败'), findsOneWidget);
    expect(find.textContaining('转写完成'), findsOneWidget);
    expect(find.textContaining('未转写'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('create folder uses Goo dialog and validates before saving', (
    WidgetTester tester,
  ) async {
    final folders = _MemoryFoldersRepository();
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        builder: (BuildContext context, Widget? child) => GooToastScope(
          child: GooSnackbarScope(child: child ?? const SizedBox.shrink()),
        ),
        home: HomePage(
          recordingsRepository: _MemoryRecordingsRepository(const []),
          foldersRepository: folders,
          transcriptionJobsRepository: _MemoryJobsRepository(const {}),
          recordingStartupReconciler: RecordingStartupReconciler(
            enabled: false,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(
      find.byWidgetPredicate(
        (Widget widget) =>
            widget is GooActionIcon && widget.semanticLabel == '新建分组',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(GooInput), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);

    await tester.tap(find.text('创建'));
    await tester.pump();
    expect(find.text('名称不能为空'), findsOneWidget);

    await tester.enterText(
      find.descendant(
        of: find.byType(GooInput),
        matching: find.byType(EditableText),
      ),
      '客户访谈',
    );
    await tester.tap(find.text('创建'));
    await tester.pumpAndSettle();

    expect(folders.createdNames, <String>['客户访谈']);
    expect(find.text('客户访谈'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'home title search normalizes case and whitespace within the current tab',
    (WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final active = <RecordingEntity>[
        RecordingEntity(
          id: 1,
          filePath: '/meetings/project.m4a',
          displayName: 'Project   Alpha',
          groupName: null,
          deletedAtMs: null,
          isFavorite: false,
          durationMs: 60_000,
          createdAtMs: 10,
        ),
        RecordingEntity(
          id: 2,
          filePath: '/meetings/chinese.m4a',
          displayName: '客户访谈',
          groupName: null,
          deletedAtMs: null,
          isFavorite: false,
          durationMs: 60_000,
          createdAtMs: 9,
        ),
      ];
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          builder: (BuildContext context, Widget? child) {
            return MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: const TextScaler.linear(2)),
              child: child ?? const SizedBox.shrink(),
            );
          },
          home: HomePage(
            recordingsRepository: _MemoryRecordingsRepository(active),
            foldersRepository: _EmptyFoldersRepository(),
            transcriptionJobsRepository: _MemoryJobsRepository(const {}),
            recordingStartupReconciler: RecordingStartupReconciler(
              enabled: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final searchField = find.descendant(
        of: find.byType(GooSearchBar),
        matching: find.byType(EditableText),
      );
      await tester.enterText(searchField, '  project alpha  ');
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.text('Project   Alpha'), findsOneWidget);
      expect(find.text('客户访谈'), findsNothing);

      await tester.enterText(searchField, '不存在');
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.text('没有匹配的记录标题'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

class _MemoryRecordingsRepository extends RecordingsRepository {
  _MemoryRecordingsRepository(this.recordings);

  final List<RecordingEntity> recordings;

  @override
  Future<List<RecordingEntity>> listActive({String? groupName}) async =>
      recordings;

  @override
  Future<List<RecordingEntity>> listDeleted() async => const [];
}

class _EmptyFoldersRepository extends FoldersRepository {
  @override
  Future<List<FolderEntity>> listFolders() async => const [];
}

class _MemoryFoldersRepository extends FoldersRepository {
  final List<String> createdNames = <String>[];

  @override
  Future<void> createFolder(String name) async {
    createdNames.add(name);
  }

  @override
  Future<List<FolderEntity>> listFolders() async => createdNames
      .map(
        (String name) =>
            FolderEntity(name: name, createdAtMs: 1, isFavorite: false),
      )
      .toList(growable: false);
}

class _MemoryJobsRepository extends TranscriptionJobsRepository {
  _MemoryJobsRepository(this.jobs);

  final Map<String, TranscriptionJobEntity> jobs;

  @override
  Future<Map<String, TranscriptionJobEntity>> findLatestByRecordingPaths(
    Iterable<String> recordingPaths,
  ) async {
    final result = <String, TranscriptionJobEntity>{};
    for (final path in recordingPaths) {
      final job = jobs[path];
      if (job != null) result[path] = job;
    }
    return result;
  }
}

TranscriptionJobEntity _job(
  RecordingEntity recording,
  String status, {
  double? progress,
}) {
  return TranscriptionJobEntity(
    id: recording.id,
    recordingPath: recording.filePath,
    recordingId: recording.id,
    generationId: null,
    durationMs: recording.durationMs,
    status: status,
    recordingMode: 'standard',
    source: 'standard_offline',
    failureStage: status == 'failed' ? 'model' : null,
    stage: status,
    progress: progress,
    attemptCount: 1,
    cancelRequested: false,
    errorCode: status == 'failed' ? 'MODEL_NOT_READY' : null,
    startedAtMs: 100,
    completedAtMs: status == 'completed' ? 200 : null,
    heartbeatAtMs: 100,
    createdAtMs: 100,
    updatedAtMs: 100,
    resultText: status == 'completed' ? '完成' : null,
    errorMessage: status == 'failed' ? '模型不可用' : null,
  );
}
