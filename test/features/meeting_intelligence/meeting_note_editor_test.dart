import 'package:flutter/material.dart';
import 'package:flutter_components/flutter_components.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/widgets/meeting_note_editor.dart';

void main() {
  testWidgets('edits action body and keeps missing metadata explicit', (
    tester,
  ) async {
    MeetingNoteEditResult? result;
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            GooToastScope(child: child ?? const SizedBox.shrink()),
        home: Builder(
          builder: (context) => Scaffold(
            body: GooButton(
              onPressed: () async {
                result = await showMeetingNoteEditor(
                  context: context,
                  insight: _actionInsight(),
                );
              },
              child: const Text('编辑'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('编辑'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(GooTextArea), 'Updated action');
    await tester.enterText(find.byType(GooInput), '');
    final panelScrollable = find
        .descendant(
          of: find.byType(ListView),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      find.text('保存修改'),
      200,
      scrollable: panelScrollable,
    );
    await tester.tap(find.text('保存修改'));
    await tester.pumpAndSettle();

    expect(result?.body, 'Updated action');
    expect(result?.clearActionOwner, isTrue);
    expect(result?.clearActionDueAt, isTrue);
  });
}

MeetingInsightEntity _actionInsight() {
  return const MeetingInsightEntity(
    id: 1,
    noteId: 1,
    kind: MeetingInsightKind.action,
    body: 'Original action',
    actionOwner: null,
    actionDueAtMs: null,
    unresolvedOwner: true,
    unresolvedDueDate: true,
    status: MeetingInsightStatus.draft,
    unsupported: false,
    resolutionState: MeetingInsightResolutionState.open,
    createdAtMs: 1,
    updatedAtMs: 1,
    reviewedAtMs: null,
    rejectedAtMs: null,
    publishedAtMs: null,
  );
}
