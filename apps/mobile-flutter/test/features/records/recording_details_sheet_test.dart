import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/router.dart';
import 'package:voice2text_flutter/features/records/widgets/recording_details_sheet.dart';
import 'package:voice2text_flutter/features/transcription/model/transcription_job_entity.dart';

void main() {
  testWidgets('Goo recording details panel opens the meeting workspace', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        routes: <String, WidgetBuilder>{
          AppRoutes.meetingDetail: (_) =>
              const Scaffold(body: Text('会议工作区测试页')),
        },
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) {
              return TextButton(
                onPressed: () => showRecordingDetailsSheet(
                  context: context,
                  title: '真机会议',
                  path: '/private/meeting.m4a',
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

    expect(find.text('真机会议'), findsOneWidget);
    expect(find.text('时长: 01:05'), findsOneWidget);
    expect(find.text('路径: /private/meeting.m4a'), findsOneWidget);
    expect(find.textContaining('失败 · 模型准备'), findsOneWidget);
    expect(find.text('模型不可用'), findsOneWidget);
    expect(find.text('查看并重试转写'), findsOneWidget);

    await tester.tap(find.text('打开会议工作区'));
    await tester.pumpAndSettle();

    expect(find.text('会议工作区测试页'), findsOneWidget);
  });
}

final _failedJob = TranscriptionJobEntity(
  id: 7,
  recordingPath: '/private/meeting.m4a',
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
