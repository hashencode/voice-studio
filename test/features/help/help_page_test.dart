import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:voice2text_flutter/app/contracts/audio_contract.dart';
import 'package:voice2text_flutter/app/theme/app_theme.dart';
import 'package:voice2text_flutter/features/help/help_page.dart';
import 'package:voice2text_flutter/features/help/model/diagnostic_report.dart';
import 'package:voice2text_flutter/features/help/service/diagnostic_report_service.dart';
import 'package:voice2text_flutter/features/help/service/diagnostic_share_service.dart';
import 'package:voice2text_flutter/features/shared/service/ephemeral_share_artifact_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('offline help and diagnostic preview work at 200% text', (
    WidgetTester tester,
  ) async {
    const channel = MethodChannel(AudioContract.recorderChannel);
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'getBuildInfo') {
        return <String, Object?>{
          'packageName': 'com.voice2text.app',
          'versionName': 'test',
          'lastUpdateTimeMs': 0,
        };
      }
      return null;
    });
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final reportService = _FakeReportService(_report());
    final shareService = _FakeShareService();

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        builder: (context, child) {
          final media = MediaQuery.of(context);
          return MediaQuery(
            data: media.copyWith(textScaler: const TextScaler.linear(2)),
            child: GooToastScope(child: GooSnackbarScope(child: child!)),
          );
        },
        home: HelpPage(
          reportService: reportService,
          shareService: shareService,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('离线帮助 v1'), findsOneWidget);
    expect(find.text('录音合规与权限'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('录音合规与权限'));
    await tester.pumpAndSettle();
    expect(find.textContaining('参与者同意'), findsOneWidget);
    await tester.tap(find.text('知道了'));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('预览安全诊断'),
      260,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('预览安全诊断'));
    await tester.pumpAndSettle();
    expect(find.text('将包含'), findsOneWidget);
    expect(find.text('不会包含'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.textContaining('不会静默联网'),
      180,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.textContaining('不会静默联网'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.text('取消'),
      220,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(shareService.buildCount, 0);
    expect(shareService.shareCount, 0);

    await tester.tap(find.text('预览安全诊断'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('生成并打开系统分享'),
      220,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.text('生成并打开系统分享'));
    await tester.pumpAndSettle();
    expect(shareService.buildCount, 1);
    expect(shareService.shareCount, 1);
    expect(find.textContaining('已打开系统分享'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final size in <Size>[
    const Size(320, 720),
    const Size(760, 900),
    const Size(1200, 900),
  ]) {
    testWidgets('help has no blocking overflow at ${size.width}', (
      WidgetTester tester,
    ) async {
      await tester.binding.setSurfaceSize(size);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: size.width == 760 ? ThemeMode.dark : ThemeMode.light,
          builder: (context, child) =>
              GooToastScope(child: GooSnackbarScope(child: child!)),
          home: HelpPage(
            reportService: _FakeReportService(_report()),
            shareService: _FakeShareService(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('帮助与反馈'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}

class _FakeReportService extends DiagnosticReportService {
  _FakeReportService(this.report);

  final DiagnosticReport report;

  @override
  Future<DiagnosticReport> build() async => report;
}

class _FakeShareService extends DiagnosticShareService {
  int buildCount = 0;
  int shareCount = 0;

  @override
  Future<DiagnosticShareArtifact> build(DiagnosticReport report) async {
    buildCount += 1;
    return DiagnosticShareArtifact(
      artifact: const EphemeralShareArtifact(
        path: '/tmp/diagnostic.zip',
        displayName: 'diagnostic.zip',
        bytes: 1,
        createdAtMs: 1,
      ),
      report: report,
    );
  }

  @override
  Future<EphemeralShareReceipt> share(DiagnosticShareArtifact artifact) async {
    shareCount += 1;
    return const EphemeralShareReceipt(
      path: '/tmp/diagnostic.zip',
      readOnly: true,
    );
  }
}

DiagnosticReport _report() {
  return const DiagnosticReport(
    generatedAtMs: 1,
    build: DiagnosticBuildInfo(
      packageName: 'com.voice2text.app',
      versionName: 'test',
    ),
    deviceProtection: DiagnosticDeviceProtection(
      storageScope: 'app_private_internal',
      protectionCategory: 'device_security_managed',
      protectionSummary: '由设备安全设置保护',
      applicationLayerEncryption: false,
      platformEncryptionStatus: 'not_exposed',
      backupPolicy: 'app_data_excluded',
    ),
    transcription: DiagnosticTranscriptionSummary(
      statusCounts: <String, int>{'completed': 1},
      stageCounts: <String, int>{'completed': 1},
      errorCategoryCounts: <String, int>{},
      timedJobCount: 1,
      averageProcessingMs: 500,
      maximumProcessingMs: 500,
    ),
  );
}
