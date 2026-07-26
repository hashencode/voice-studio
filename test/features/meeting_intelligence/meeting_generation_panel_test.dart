import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_template.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/widgets/meeting_generation_panel.dart';

void main() {
  testWidgets(
    'shows all six product templates plus general and returns selection',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      MeetingGenerationSelection? result;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) {
            final media = MediaQuery.of(context);
            return MediaQuery(
              data: media.copyWith(textScaler: const TextScaler.linear(2)),
              child: GooToastScope(child: child ?? const SizedBox.shrink()),
            );
          },
          home: Builder(
            builder: (context) => Scaffold(
              body: GooButton(
                onPressed: () async {
                  result = await showMeetingGenerationPanel(
                    context: context,
                    payloadSummary: '12 个转写片段，00:00–10:00，预计 2 次请求',
                  );
                },
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();
      for (final label in <String>['通用', '周会', '评审', '访谈', '销售', '复盘', '一对一']) {
        expect(find.text(label), findsOneWidget);
      }
      final panelScrollable = find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.drag(panelScrollable, const Offset(0, -500));
      await tester.pumpAndSettle();
      await tester.tap(find.text('销售'));
      await tester.drag(panelScrollable, const Offset(0, -600));
      await tester.pumpAndSettle();
      expect(find.textContaining('预计 2 次请求'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('下一步'),
        200,
        scrollable: panelScrollable,
      );
      await tester.drag(panelScrollable, const Offset(0, -100));
      await tester.pumpAndSettle();
      await tester.tap(find.text('下一步'));
      await tester.pumpAndSettle();

      expect(result?.templateId, MeetingTemplateId.sales);
      expect(tester.takeException(), isNull);
    },
  );
}
