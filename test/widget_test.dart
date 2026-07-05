import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:voice2text_flutter/app/app.dart';

void main() {
  testWidgets('app boots on home page', (WidgetTester tester) async {
    await tester.pumpWidget(const Voice2TextApp());
    await tester.pumpAndSettle();

    expect(find.text('音频'), findsAtLeastNWidgets(2));
    expect(find.text('实时'), findsOneWidget);
    expect(find.text('全部音频'), findsOneWidget);
    expect(find.byIcon(LucideIcons.search300), findsWidgets);
    expect(find.byIcon(LucideIcons.mic300), findsOneWidget);
  });

  testWidgets('home page navigates to recording page', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const Voice2TextApp());
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(LucideIcons.mic300));
    await tester.pumpAndSettle();

    expect(find.text('未命名录音'), findsOneWidget);
    expect(find.text('编辑'), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    expect(find.text('点击中间按钮开始录音'), findsOneWidget);
  });
}
