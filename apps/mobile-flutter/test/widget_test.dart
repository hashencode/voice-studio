import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:voice2text_flutter/app/app.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/home/home_page.dart';
import 'package:voice2text_flutter/features/home/model/folder_entity.dart';
import 'package:voice2text_flutter/features/home/repository/folders_repository.dart';
import 'package:voice2text_flutter/features/records/model/recording_entity.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcription_jobs_repository.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_segments_repository.dart';

void main() {
  List<MethodCall> capturePlatformCalls(WidgetTester tester) {
    final List<MethodCall> platformCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (MethodCall methodCall) async {
        platformCalls.add(methodCall);
        return null;
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      );
    });
    return platformCalls;
  }

  int selectionClickCount(List<MethodCall> platformCalls) {
    return platformCalls
        .where(
          (MethodCall call) =>
              call.method == 'HapticFeedback.vibrate' &&
              call.arguments == 'HapticFeedbackType.selectionClick',
        )
        .length;
  }

  Finder moreActionFinder() {
    return find.byWidgetPredicate(
      (Widget widget) =>
          widget is GooActionIcon && widget.semanticLabel == '更多操作',
    );
  }

  Future<void> pumpHomePage(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: _FakeRecordingsRepository(_recordingFixtures()),
          foldersRepository: _FakeFoldersRepository(),
          transcriptionJobsRepository: _FakeTranscriptionJobsRepository(),
          transcriptSegmentsRepository: _FakeTranscriptSegmentsRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('app boots on home page', (WidgetTester tester) async {
    await tester.pumpWidget(const Voice2TextApp());
    await tester.pumpAndSettle();

    expect(find.text('音频'), findsOneWidget);
    expect(find.text('实时'), findsNothing);
    expect(find.text('全部音频'), findsOneWidget);
    expect(find.byTooltip('搜索'), findsNothing);
    expect(find.byIcon(LucideIcons.mic300), findsOneWidget);
    expect(find.byType(GooToastScope), findsOneWidget);
    expect(find.byType(GooSnackbarScope), findsOneWidget);
  });

  testWidgets('home page navigates to recording page', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const Voice2TextApp());
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.mic300));
    await tester.pumpAndSettle();

    expect(find.text('未命名录音'), findsOneWidget);
    expect(find.text('备注'), findsOneWidget);
    expect(find.byIcon(Icons.mic_rounded), findsOneWidget);
    expect(find.text('点击中间按钮开始录音'), findsOneWidget);
  });

  testWidgets('empty repository shows a truthful empty state', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: HomePage(
          recordingsRepository: _FakeRecordingsRepository(
            const <RecordingEntity>[],
          ),
          foldersRepository: _FakeFoldersRepository(),
          transcriptionJobsRepository: _FakeTranscriptionJobsRepository(),
          transcriptSegmentsRepository: _FakeTranscriptSegmentsRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('暂无录音文件'), findsOneWidget);
    expect(find.byType(GooListItem), findsNothing);
    expect(find.text('产品讨论会-2605071410'), findsNothing);
  });

  testWidgets('home selection uses Goo overlay toolbar and haptics', (
    WidgetTester tester,
  ) async {
    final List<MethodCall> platformCalls = capturePlatformCalls(tester);

    await pumpHomePage(tester);

    final Finder initialRows = find.byType(GooListItem);
    expect(initialRows, findsWidgets);
    final List<GooListItem> rows = tester
        .widgetList<GooListItem>(initialRows)
        .toList(growable: false);
    final int rowCount = rows.length;
    final String firstTitle = rows.first.title;

    await tester.longPress(find.text(firstTitle));
    await tester.pumpAndSettle();

    expect(selectionClickCount(platformCalls), 1);
    expect(find.text('已选择 1 项'), findsOneWidget);
    expect(find.text('重命名'), findsOneWidget);
    expect(find.text('移动'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    expect(find.text('导出'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
    expect(find.bySemanticsLabel('音频选择操作'), findsOneWidget);
    expect(find.byIcon(LucideIcons.mic300), findsNothing);

    final SemanticsNode checkboxSemantics = tester.getSemantics(
      find.bySemanticsLabel('选择 $firstTitle'),
    );
    expect(checkboxSemantics.flagsCollection.isChecked, ui.CheckedState.isTrue);

    int expectedHaptics = 1;
    int selectedCount = 1;
    if (rowCount > 2) {
      await tester.tap(find.text(rows[1].title));
      await tester.pumpAndSettle();

      expectedHaptics += 1;
      selectedCount = 2;
      expect(selectionClickCount(platformCalls), expectedHaptics);
      expect(find.text('已选择 2 项'), findsOneWidget);
    }

    if (rowCount > selectedCount) {
      await tester.tap(find.text('全选'));
      await tester.pumpAndSettle();

      expectedHaptics += 1;
      expect(selectionClickCount(platformCalls), expectedHaptics);
      expect(find.text('已选择 $rowCount 项'), findsOneWidget);
    }
    expect(find.text('取消全选'), findsOneWidget);

    await tester.tap(find.text('取消全选'));
    await tester.pumpAndSettle();

    expectedHaptics += 1;
    expect(selectionClickCount(platformCalls), expectedHaptics);
    expect(find.text('已选择 $rowCount 项'), findsNothing);
    expect(find.byIcon(LucideIcons.mic300), findsOneWidget);
  });

  testWidgets('home non-selection flows do not trigger selection haptics', (
    WidgetTester tester,
  ) async {
    final List<MethodCall> platformCalls = capturePlatformCalls(tester);

    await pumpHomePage(tester);

    expect(find.byType(GooListItem), findsWidgets);

    await tester.tap(moreActionFinder().first);
    await tester.pumpAndSettle();

    expect(selectionClickCount(platformCalls), 0);
    expect(find.text('重命名'), findsOneWidget);
    expect(find.text('收藏'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    await tester.longPress(find.byType(GooListItem).first);
    await tester.pumpAndSettle();
    expect(selectionClickCount(platformCalls), 1);

    await tester.tap(find.text('会议音频'));
    await tester.pumpAndSettle();

    expect(selectionClickCount(platformCalls), 1);
    expect(find.text('已选择 1 项'), findsNothing);
  });
}

List<RecordingEntity> _recordingFixtures() {
  return <RecordingEntity>[
    RecordingEntity(
      id: 1,
      filePath: '/tmp/import-2605071125.m4a',
      displayName: '导入音频-2605071125',
      groupName: null,
      deletedAtMs: null,
      isFavorite: false,
      durationMs: 0,
      createdAtMs: DateTime(2026, 5, 7, 11, 25).millisecondsSinceEpoch,
    ),
    RecordingEntity(
      id: 2,
      filePath: '/tmp/product-2605071410.m4a',
      displayName: '产品讨论会-2605071410',
      groupName: null,
      deletedAtMs: null,
      isFavorite: false,
      durationMs: 88000,
      createdAtMs: DateTime(2026, 5, 7, 14, 10).millisecondsSinceEpoch,
    ),
    RecordingEntity(
      id: 3,
      filePath: '/tmp/weekly-2605080932.m4a',
      displayName: '周会纪要-2605080932',
      groupName: null,
      deletedAtMs: null,
      isFavorite: false,
      durationMs: 766000,
      createdAtMs: DateTime(2026, 5, 8, 9, 32).millisecondsSinceEpoch,
    ),
    RecordingEntity(
      id: 4,
      filePath: '/tmp/interview-2605081548.m4a',
      displayName: '采访录音-2605081548',
      groupName: null,
      deletedAtMs: null,
      isFavorite: false,
      durationMs: 1395000,
      createdAtMs: DateTime(2026, 5, 8, 15, 48).millisecondsSinceEpoch,
    ),
  ];
}

class _FakeRecordingsRepository extends RecordingsRepository {
  _FakeRecordingsRepository(this.recordings);

  final List<RecordingEntity> recordings;

  @override
  Future<List<RecordingEntity>> listActive({String? groupName}) async {
    final String normalizedGroupName = groupName?.trim() ?? '';
    return recordings
        .where((RecordingEntity recording) {
          if (recording.deletedAtMs != null) {
            return false;
          }
          if (normalizedGroupName.isEmpty || normalizedGroupName == 'all') {
            return true;
          }
          return recording.groupName == normalizedGroupName;
        })
        .toList(growable: false);
  }

  @override
  Future<List<RecordingEntity>> listDeleted() async {
    return recordings
        .where((RecordingEntity recording) => recording.deletedAtMs != null)
        .toList(growable: false);
  }
}

class _FakeFoldersRepository extends FoldersRepository {
  @override
  Future<List<FolderEntity>> listFolders() async {
    return const <FolderEntity>[];
  }
}

class _FakeTranscriptionJobsRepository extends TranscriptionJobsRepository {}

class _FakeTranscriptSegmentsRepository extends TranscriptSegmentsRepository {}
