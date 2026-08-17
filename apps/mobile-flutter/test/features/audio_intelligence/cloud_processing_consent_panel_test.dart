import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/widgets/cloud_processing_consent_panel.dart';

void main() {
  const request = CloudProcessingConsentRequest(
    providerLabel: 'DeepSeek',
    modelId: 'deepseek-v4-flash',
    inputStartMs: 0,
    inputEndMs: 125000,
    segmentCount: 12,
    estimatedRequestCount: 2,
    speakerLabelsIncluded: true,
  );

  test('payload summary names the exact text range and request count', () {
    expect(request.payloadSummary, '12 个转写片段，含说话人标签，00:00–02:05，预计 2 次请求');
  });

  testWidgets('consent panel explains boundary and exposes explicit actions', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var confirmed = false;
    var cancelled = false;
    var policyOpened = false;

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.light(),
        builder: (BuildContext context, Widget? child) {
          final mediaQuery = MediaQuery.of(context);
          return MediaQuery(
            data: mediaQuery.copyWith(textScaler: const TextScaler.linear(2)),
            child: GooToastScope(child: child ?? const SizedBox.shrink()),
          );
        },
        home: Scaffold(
          body: CloudProcessingConsentPanel(
            request: request,
            onCancel: () => cancelled = true,
            onConfirm: () => confirmed = true,
            onOpenDataPolicy: () => policyOpened = true,
          ),
        ),
      ),
    );

    expect(find.text('音频文本将离开设备'), findsOneWidget);
    expect(find.text('DeepSeek · deepseek-v4-flash'), findsOneWidget);
    expect(find.text(request.payloadSummary), findsOneWidget);
    expect(find.textContaining('不发送音频、附件、其他音频或诊断数据'), findsOneWidget);

    await tester.scrollUntilVisible(find.text('查看第三方数据政策'), 200);
    await tester.tap(find.text('查看第三方数据政策'));
    await tester.scrollUntilVisible(find.text('取消'), 200);
    await tester.drag(find.byType(ListView), const Offset(0, -120));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.tap(find.text('同意并生成'));

    expect(policyOpened, isTrue);
    expect(cancelled, isTrue);
    expect(confirmed, isTrue);
    expect(tester.takeException(), isNull);
  });
}
