import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_intelligence_job_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_jobs_repository.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_repository.dart';
import 'package:voice2text_flutter/features/audios/controller/audio_review_controller.dart';
import 'package:voice2text_flutter/features/audios/audio_detail_page.dart';
import 'package:voice2text_flutter/features/audios/model/audio_record.dart';
import 'package:voice2text_flutter/features/audios/service/audio_playback_service.dart';
import 'package:voice2text_flutter/features/records/model/recording_entity.dart';
import 'package:voice2text_flutter/features/recording/model/recording_annotation_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_generation_entity.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

void main() {
  Future<void> pumpPage(
    WidgetTester tester, {
    required AudioReviewController controller,
    ThemeData? theme,
    double textScale = 1,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: theme ?? AppTheme.light(),
        builder: (BuildContext context, Widget? child) {
          return MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: GooToastScope(
              child: GooSnackbarScope(child: child ?? const SizedBox.shrink()),
            ),
          );
        },
        home: AudioDetailPage(
          key: ObjectKey(controller),
          recordingId: 1,
          controller: controller,
          intelligenceRepository: _EmptyIntelligenceRepository(),
          intelligenceJobsRepository: _EmptyIntelligenceJobsRepository(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('shows explicit loading and missing-audio states', (
    WidgetTester tester,
  ) async {
    final loadingController = _FakeAudioReviewController(loading: true);
    addTearDown(loadingController.dispose);
    await pumpPage(tester, controller: loadingController);

    expect(find.text('正在打开音频'), findsOneWidget);

    final errorController = _FakeAudioReviewController(error: '音频记录不存在或已删除');
    addTearDown(errorController.dispose);
    await pumpPage(tester, controller: errorController);

    expect(find.text('无法打开音频'), findsOneWidget);
    expect(find.text('音频记录不存在或已删除'), findsOneWidget);
  });

  testWidgets(
    'compact large-text layout exposes playback and segment semantics',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(430, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = _FakeAudioReviewController(
        audio: _audio(segments: <TranscriptSegmentEntity>[_segment()]),
        currentSegmentIndex: 0,
      );
      addTearDown(controller.dispose);
      final semantics = tester.ensureSemantics();
      try {
        await pumpPage(tester, controller: controller, textScale: 1.5);

        expect(tester.takeException(), isNull);
        expect(find.text('季度评审'), findsOneWidget);
        expect(find.bySemanticsLabel(RegExp('音频播放器')), findsOneWidget);
        expect(find.bySemanticsLabel(RegExp('播放')), findsWidgets);
        expect(
          find.bySemanticsLabel(RegExp('当前片段，00:00，.*第一段音频内容')),
          findsOneWidget,
        );
        expect(find.text('AI 音频洞察尚未生成'), findsOneWidget);
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets(
    'medium dark layout renders the canonical empty transcript state',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(700, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = _FakeAudioReviewController(
        audio: _audio(segments: const <TranscriptSegmentEntity>[]),
      );
      addTearDown(controller.dispose);

      await pumpPage(
        tester,
        controller: controller,
        theme: AppTheme.dark(),
        textScale: 1.3,
      );

      expect(tester.takeException(), isNull);
      expect(
        Theme.of(tester.element(find.byType(AudioDetailPage))).brightness,
        Brightness.dark,
      );
      expect(find.text('暂无音频时间线'), findsOneWidget);
      expect(find.text('转写完成后，带时间戳的片段会显示在这里。'), findsOneWidget);
    },
  );

  testWidgets('timeline renders durable markers and notes without transcript', (
    WidgetTester tester,
  ) async {
    final controller = _FakeAudioReviewController(
      audio: _audio(
        segments: const <TranscriptSegmentEntity>[],
        annotations: const <RecordingAnnotationEntity>[
          RecordingAnnotationEntity(
            id: 1,
            sessionId: 'session-1',
            kind: RecordingAnnotationKind.marker,
            positionMs: 1_250,
            createdAtMs: 1,
            updatedAtMs: 1,
          ),
          RecordingAnnotationEntity(
            id: 2,
            sessionId: 'session-1',
            kind: RecordingAnnotationKind.note,
            positionMs: 2_500,
            text: '跟进客户报价',
            createdAtMs: 1,
            updatedAtMs: 1,
          ),
        ],
      ),
    );
    addTearDown(controller.dispose);

    await pumpPage(tester, controller: controller);

    expect(find.text('音频时间线'), findsOneWidget);
    expect(find.text('重点标记'), findsOneWidget);
    expect(find.textContaining('00:01'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('跟进客户报价'),
      120,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
    expect(find.text('跟进客户报价'), findsOneWidget);
    expect(find.text('00:02 · 会中备注'), findsOneWidget);
  });

  testWidgets('undo and redo expose distinct disabled semantics', (
    WidgetTester tester,
  ) async {
    final controller = _FakeAudioReviewController(
      audio: _audio(segments: <TranscriptSegmentEntity>[_segment()]),
    );
    addTearDown(controller.dispose);
    final semantics = tester.ensureSemantics();
    try {
      await pumpPage(tester, controller: controller);

      final undo = tester.getSemantics(find.bySemanticsLabel('撤销最近一次转写编辑'));
      final redo = tester.getSemantics(find.bySemanticsLabel('重做最近一次撤销的转写编辑'));
      expect(undo.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
      expect(redo.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
    } finally {
      semantics.dispose();
    }
  });

  testWidgets('auto follow reaches a far variable-height segment lazily', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final segments = List<TranscriptSegmentEntity>.generate(
      3000,
      (index) => _segment(
        id: index + 1,
        sequenceId: index,
        text: index == 2999 ? '最后一个远距离片段' : '片段 $index',
        startMs: index * 1000,
        endMs: index * 1000 + 800,
      ),
    );
    final controller = _FakeAudioReviewController(
      audio: _audio(segments: segments),
      currentSegmentIndex: 2999,
    );
    addTearDown(controller.dispose);

    await pumpPage(tester, controller: controller, textScale: 2);
    await tester.pump(const Duration(seconds: 1));

    expect(tester.takeException(), isNull);
    expect(find.text('最后一个远距离片段'), findsOneWidget);
    expect(find.text('片段 0'), findsNothing);
  });

  testWidgets(
    'expanded landscape keeps review tools and timeline usable at 200 percent text',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(932, 430);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = _FakeAudioReviewController(
        audio: _audio(segments: <TranscriptSegmentEntity>[_segment()]),
      );
      addTearDown(controller.dispose);
      final semantics = tester.ensureSemantics();
      try {
        await pumpPage(tester, controller: controller, textScale: 2);

        expect(tester.takeException(), isNull);
        expect(find.bySemanticsLabel('音频复核工具，可上下滚动'), findsOneWidget);
        expect(find.text('音频时间线'), findsOneWidget);
        expect(find.text('第一段音频内容'), findsOneWidget);
      } finally {
        semantics.dispose();
      }
    },
  );
}

AudioRecord _audio({
  required List<TranscriptSegmentEntity> segments,
  List<RecordingAnnotationEntity> annotations =
      const <RecordingAnnotationEntity>[],
}) {
  return AudioRecord(
    recording: RecordingEntity(
      id: 1,
      filePath: '/tmp/quarterly-review.m4a',
      displayName: '季度评审',
      groupName: null,
      deletedAtMs: null,
      isFavorite: false,
      durationMs: 120000,
      createdAtMs: 1,
    ),
    generation: TranscriptGenerationEntity(
      id: 1,
      recordingId: 1,
      recordingPath: '/tmp/quarterly-review.m4a',
      jobId: 1,
      status: 'active',
      source: 'offline',
      mergedText: segments.map((segment) => segment.text).join('\n'),
      hasUserEdits: false,
      hasEvidenceLinks: false,
      createdAtMs: 1,
      activatedAtMs: 1,
      updatedAtMs: 1,
    ),
    segments: segments,
    annotations: annotations,
    latestJob: null,
  );
}

TranscriptSegmentEntity _segment({
  int id = 1,
  int sequenceId = 0,
  String text = '第一段音频内容',
  int startMs = 0,
  int endMs = 5000,
}) {
  return TranscriptSegmentEntity(
    id: id,
    recordingPath: '/tmp/quarterly-review.m4a',
    recordingId: 1,
    generationId: 1,
    jobId: 1,
    sequenceId: sequenceId,
    text: text,
    startMs: startMs,
    endMs: endMs,
    isFinal: true,
    source: 'offline',
    confidence: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  );
}

class _FakeAudioReviewController extends AudioReviewController {
  _FakeAudioReviewController({
    AudioRecord? audio,
    bool loading = false,
    String? error,
    int? currentSegmentIndex,
  }) : _audio = audio,
       _loading = loading,
       _error = error,
       _currentSegmentIndex = currentSegmentIndex,
       super(recordingId: 1, playbackService: _FakePlaybackService());

  final AudioRecord? _audio;
  final bool _loading;
  final String? _error;
  final int? _currentSegmentIndex;

  @override
  AudioRecord? get audio => _audio;

  @override
  bool get loading => _loading;

  @override
  String? get error => _error;

  @override
  int? get currentSegmentIndex => _currentSegmentIndex;

  @override
  Future<void> load() async {}
}

class _FakePlaybackService extends AudioPlaybackService {
  @override
  AudioPlaybackSnapshot get snapshot => const AudioPlaybackSnapshot(
    initialized: true,
    playing: false,
    position: Duration.zero,
    duration: Duration(minutes: 2),
    speed: 1,
  );
}

class _EmptyIntelligenceRepository extends AudioIntelligenceRepository {
  @override
  Future<AudioIntelligenceBundle?> findLatestForRecording(
    int recordingId,
  ) async {
    return null;
  }
}

class _EmptyIntelligenceJobsRepository extends AudioIntelligenceJobsRepository {
  @override
  Future<AudioIntelligenceJobEntity?> findLatestForRecording(
    int recordingId,
  ) async {
    return null;
  }
}
