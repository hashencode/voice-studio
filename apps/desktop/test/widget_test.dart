import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show Size;
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/app/desktop_app.dart';
import 'package:voice2text_desktop/app/desktop_home_model.dart';
import 'package:voice2text_desktop/features/processing/desktop_job.dart';

void main() {
  testWidgets(
    'uninstalled engine is truthful and never displays a fake transcript',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1100, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final model = _FakeHomeModel();

      await tester.pumpWidget(Voice2TextDesktopApp(homeModel: model));
      await tester.pumpAndSettle();

      expect(find.text('本机处理引擎尚不可用'), findsOneWidget);
      expect(find.text('已入队'), findsOneWidget);
      expect(find.textContaining('模拟转写'), findsNothing);
      expect(find.text('导入会议文件'), findsOneWidget);
    },
  );
}

class _FakeHomeModel extends ChangeNotifier implements DesktopHomeModel {
  @override
  bool engineAvailable = false;

  @override
  String engineAvailabilityMessage = '尚未安装通过 macOS 准入的模型；任务会安全保留。';

  @override
  String? errorMessage;

  @override
  bool importing = false;

  @override
  List<DesktopProcessingJob> jobs = const <DesktopProcessingJob>[
    DesktopProcessingJob(
      id: 1,
      recordingId: 1,
      displayName: '项目周会.wav',
      recordingPath: '/private/meeting.wav',
      fingerprintSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      state: DesktopJobState.pending,
      stage: 'queued',
      progress: 0,
      createdAtMs: 1,
    ),
  ];

  @override
  bool loading = false;

  @override
  String? noticeMessage;

  @override
  Future<void> importMeeting() async {}

  @override
  Future<void> load() async {
    notifyListeners();
  }
}
