import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/router.dart';
import 'package:voice2text_flutter/features/records/widgets/recording_details_sheet.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';

void main() {
  testWidgets('Goo recording details panel opens the audio workspace', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        routes: <String, WidgetBuilder>{
          AppRoutes.audioDetail: (_) => const Scaffold(body: Text('音频工作区测试页')),
        },
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) {
              return TextButton(
                onPressed: () => showRecordingDetailsSheet(
                  context: context,
                  title: '真机音频',
                  path: '/private/audio.m4a',
                  durationMs: 65_000,
                  createdAtMs: 1_750_000_000_000,
                  latestJob: _failedJob,
                  recordingId: 42,
                ),
                child: const Text('查看详情'),
              );
            },
          ),
        ),
      ),
    );

    await tester.tap(find.text('查看详情'));
    await tester.pumpAndSettle();

    expect(find.text('真机音频'), findsOneWidget);
    expect(find.text('时长: 01:05'), findsOneWidget);
    expect(find.textContaining('失败 · 模型准备'), findsOneWidget);
    expect(find.text('模型不可用'), findsOneWidget);
    expect(find.text('查看并重试转写'), findsOneWidget);

    await tester.tap(find.text('打开音频工作区'));
    await tester.pumpAndSettle();

    expect(find.text('音频工作区测试页'), findsOneWidget);
  });

  testWidgets(
    'blank transcription body keeps task state and retry navigation',
    (WidgetTester tester) async {
      for (final body in <String?>[null, ' \n ']) {
        final job = TranscriptionJobEntity.fromMap(<String, Object?>{
          'id': 7,
          'recording_path': '/private/audio.m4a',
          'recording_id': 42,
          'duration_ms': 65_000,
          'status': 'failed',
          'failure_stage': 'model',
          'stage': 'failed',
          'created_at_ms': 100,
          'updated_at_ms': 100,
          'result_text': body,
          'error_message': body,
        });
        await tester.pumpWidget(
          MaterialApp(
            routes: <String, WidgetBuilder>{
              AppRoutes.transcription: (_) =>
                  const Scaffold(body: Text('转写重试测试页')),
            },
            home: Scaffold(
              body: Builder(
                builder: (BuildContext context) => TextButton(
                  onPressed: () => showRecordingDetailsSheet(
                    context: context,
                    title: '真机音频',
                    path: job.recordingPath,
                    durationMs: job.durationMs,
                    createdAtMs: job.createdAtMs,
                    latestJob: job,
                    recordingId: job.recordingId,
                  ),
                  child: const Text('查看详情'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('查看详情'));
        await tester.pumpAndSettle();

        expect(find.textContaining('失败 · 模型准备'), findsOneWidget);
        expect(find.textContaining(job.recordingPath), findsNothing);
        expect(find.text('查看并重试转写'), findsOneWidget);
        await tester.tap(find.text('查看并重试转写'));
        await tester.pumpAndSettle();
        expect(find.text('转写重试测试页'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}

final _failedJob = TranscriptionJobEntity(
  id: 7,
  recordingPath: '/private/audio.m4a',
  recordingId: 42,
  generationId: null,
  durationMs: 65_000,
  status: 'failed',
  recordingMode: 'standard',
  source: 'standard_offline',
  failureStage: 'model',
  stage: 'failed',
  progress: 0,
  attemptCount: 1,
  cancelRequested: false,
  errorCode: 'MODEL_NOT_READY',
  startedAtMs: 100,
  completedAtMs: null,
  heartbeatAtMs: 100,
  createdAtMs: 100,
  updatedAtMs: 100,
  resultText: null,
  errorMessage: '模型不可用',
);
