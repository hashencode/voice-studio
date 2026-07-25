import 'package:sqflite/sqflite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/transcription/repository/transcript_revisions_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  test(
    'edit undo redo keeps segment, merged text, and bounds consistent',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final seeded = await _seedGeneration(
        fixture.database,
        path: '/edit.m4a',
        texts: const <String>['before'],
      );
      final repository = TranscriptRevisionsRepository(
        database: fixture.appDatabase,
      );

      final revision = await repository.saveEdit(
        segmentId: seeded.segmentIds.single,
        text: 'after',
        markReviewed: true,
      );
      expect(revision?.previousText, 'before');
      expect(await repository.canUndo(seeded.generationId), isTrue);
      expect(await repository.canRedo(seeded.generationId), isFalse);
      await _expectState(
        fixture.database,
        generationId: seeded.generationId,
        segmentId: seeded.segmentIds.single,
        text: 'after',
        mergedText: 'after',
        reverted: false,
        invalidated: false,
      );
      final explicitlyReviewed = (await fixture.database.query(
        'transcript_segments',
        where: 'id = ?',
        whereArgs: <Object>[seeded.segmentIds.single],
      )).single;
      expect(explicitlyReviewed['review_state'], 'reviewed');
      expect(explicitlyReviewed['reviewed_at_ms'], isNotNull);

      expect(
        await repository.undoLastForGeneration(seeded.generationId),
        isNotNull,
      );
      expect(await repository.canUndo(seeded.generationId), isFalse);
      expect(await repository.canRedo(seeded.generationId), isTrue);
      await _expectState(
        fixture.database,
        generationId: seeded.generationId,
        segmentId: seeded.segmentIds.single,
        text: 'before',
        mergedText: 'before',
        reverted: true,
        invalidated: false,
      );

      expect(
        await repository.redoLastForGeneration(seeded.generationId),
        isNotNull,
      );
      expect(await repository.canUndo(seeded.generationId), isTrue);
      expect(await repository.canRedo(seeded.generationId), isFalse);
      await _expectState(
        fixture.database,
        generationId: seeded.generationId,
        segmentId: seeded.segmentIds.single,
        text: 'after',
        mergedText: 'after',
        reverted: false,
        invalidated: false,
      );
    },
  );

  test('three edits support deterministic two-step undo and redo', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final seeded = await _seedGeneration(
      fixture.database,
      path: '/multi-edit.m4a',
      texts: const <String>['A', 'B'],
    );
    final repository = TranscriptRevisionsRepository(
      database: fixture.appDatabase,
    );

    await repository.saveEdit(segmentId: seeded.segmentIds[0], text: 'A1');
    await repository.saveEdit(segmentId: seeded.segmentIds[1], text: 'B1');
    await repository.saveEdit(segmentId: seeded.segmentIds[0], text: 'A2');

    await repository.undoLastForGeneration(seeded.generationId);
    await repository.undoLastForGeneration(seeded.generationId);
    expect(await _texts(fixture.database, seeded.generationId), const <String>[
      'A1',
      'B',
    ]);
    expect(await _merged(fixture.database, seeded.generationId), 'A1 B');

    final reopenedRepository = TranscriptRevisionsRepository(
      database: fixture.appDatabase,
    );
    expect(await reopenedRepository.canRedo(seeded.generationId), isTrue);
    await reopenedRepository.redoLastForGeneration(seeded.generationId);
    expect(await _texts(fixture.database, seeded.generationId), const <String>[
      'A1',
      'B1',
    ]);
    await reopenedRepository.redoLastForGeneration(seeded.generationId);
    expect(await _texts(fixture.database, seeded.generationId), const <String>[
      'A2',
      'B1',
    ]);
    expect(await _merged(fixture.database, seeded.generationId), 'A2 B1');
    expect(await reopenedRepository.canRedo(seeded.generationId), isFalse);
  });

  test('new edit invalidates the abandoned redo branch only', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final first = await _seedGeneration(
      fixture.database,
      path: '/branch.m4a',
      texts: const <String>['A'],
    );
    final second = await _seedGeneration(
      fixture.database,
      path: '/isolated.m4a',
      texts: const <String>['X'],
    );
    final repository = TranscriptRevisionsRepository(
      database: fixture.appDatabase,
    );

    await repository.saveEdit(segmentId: first.segmentIds.single, text: 'B');
    await repository.undoLastForGeneration(first.generationId);
    await repository.saveEdit(segmentId: second.segmentIds.single, text: 'Y');
    await repository.undoLastForGeneration(second.generationId);
    await repository.saveEdit(segmentId: first.segmentIds.single, text: 'C');

    expect(await repository.canRedo(first.generationId), isFalse);
    expect(await repository.canRedo(second.generationId), isTrue);
    final firstRevisions = await fixture.database.query(
      'transcript_revisions',
      where: 'generation_id = ?',
      whereArgs: <Object>[first.generationId],
      orderBy: 'id ASC',
    );
    expect(firstRevisions.first['reverted_at_ms'], isNotNull);
    expect(firstRevisions.first['invalidated_at_ms'], isNotNull);
    expect(firstRevisions.last['reverted_at_ms'], isNull);
    expect(firstRevisions.last['invalidated_at_ms'], isNull);
    expect(await repository.redoLastForGeneration(first.generationId), isNull);
    expect(await _texts(fixture.database, first.generationId), const <String>[
      'C',
    ]);
  });

  test(
    'redo order stays deterministic when the device clock moves backward',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final seeded = await _seedGeneration(
        fixture.database,
        path: '/clock-change.m4a',
        texts: const <String>['A'],
      );
      final repository = TranscriptRevisionsRepository(
        database: fixture.appDatabase,
      );

      await repository.saveEdit(segmentId: seeded.segmentIds.single, text: 'B');
      await repository.saveEdit(segmentId: seeded.segmentIds.single, text: 'C');
      final firstUndo = await repository.undoLastForGeneration(
        seeded.generationId,
      );
      const futureTimestamp = 5000000000000;
      await fixture.database.update(
        'transcript_revisions',
        <String, Object?>{'reverted_at_ms': futureTimestamp},
        where: 'id = ?',
        whereArgs: <Object>[firstUndo!.id],
      );

      final secondUndo = await repository.undoLastForGeneration(
        seeded.generationId,
      );
      expect(secondUndo!.revertedAtMs, futureTimestamp + 1);
      expect(await _texts(fixture.database, seeded.generationId), const ['A']);

      final redone = await repository.redoLastForGeneration(
        seeded.generationId,
      );
      expect(redone?.nextText, 'B');
      expect(await _texts(fixture.database, seeded.generationId), const ['B']);
    },
  );

  test(
    'undo follows edit insertion order when the clock moves backward',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final seeded = await _seedGeneration(
        fixture.database,
        path: '/edit-clock-change.m4a',
        texts: const <String>['A'],
      );
      final repository = TranscriptRevisionsRepository(
        database: fixture.appDatabase,
      );

      final first = await repository.saveEdit(
        segmentId: seeded.segmentIds.single,
        text: 'B',
      );
      await fixture.database.update(
        'transcript_revisions',
        const <String, Object?>{'created_at_ms': 5000000000000},
        where: 'id = ?',
        whereArgs: <Object>[first!.id],
      );
      await repository.saveEdit(segmentId: seeded.segmentIds.single, text: 'C');

      final undone = await repository.undoLastForGeneration(
        seeded.generationId,
      );
      expect(undone?.nextText, 'C');
      expect(await _texts(fixture.database, seeded.generationId), const ['B']);
    },
  );
}

Future<({int generationId, List<int> segmentIds})> _seedGeneration(
  Database db, {
  required String path,
  required List<String> texts,
}) async {
  final recordingId = await db.insert('recordings', <String, Object?>{
    'file_path': path,
    'duration_ms': 10000,
    'created_at_ms': 1,
  });
  final generationId = await db
      .insert('transcript_generations', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': path,
        'status': 'active',
        'source': 'test',
        'merged_text': texts.join(' '),
        'created_at_ms': 1,
        'updated_at_ms': 1,
      });
  final segmentIds = <int>[];
  for (var index = 0; index < texts.length; index += 1) {
    segmentIds.add(
      await db.insert('transcript_segments', <String, Object?>{
        'recording_id': recordingId,
        'recording_path': path,
        'generation_id': generationId,
        'sequence_id': index,
        'text': texts[index],
        'start_ms': 125 + (index * 1000),
        'end_ms': 975 + (index * 1000),
        'source': 'test',
        'created_at_ms': 1,
        'updated_at_ms': 1,
      }),
    );
  }
  await db.update(
    'recordings',
    <String, Object?>{'active_generation_id': generationId},
    where: 'id = ?',
    whereArgs: <Object>[recordingId],
  );
  return (generationId: generationId, segmentIds: segmentIds);
}

Future<void> _expectState(
  Database db, {
  required int generationId,
  required int segmentId,
  required String text,
  required String mergedText,
  required bool reverted,
  required bool invalidated,
}) async {
  final segment = (await db.query(
    'transcript_segments',
    where: 'id = ?',
    whereArgs: <Object>[segmentId],
  )).single;
  expect(segment['text'], text);
  expect(segment['start_ms'], 125);
  expect(segment['end_ms'], 975);
  expect(await _merged(db, generationId), mergedText);
  final revision = (await db.query(
    'transcript_revisions',
    where: 'generation_id = ?',
    whereArgs: <Object>[generationId],
    orderBy: 'id DESC',
    limit: 1,
  )).single;
  expect(revision['reverted_at_ms'] != null, reverted);
  expect(revision['invalidated_at_ms'] != null, invalidated);
}

Future<List<String>> _texts(Database db, int generationId) async {
  final rows = await db.query(
    'transcript_segments',
    columns: <String>['text'],
    where: 'generation_id = ?',
    whereArgs: <Object>[generationId],
    orderBy: 'sequence_id ASC',
  );
  return rows.map<String>((row) => row['text'] as String).toList();
}

Future<String> _merged(Database db, int generationId) async {
  final row = (await db.query(
    'transcript_generations',
    columns: <String>['merged_text'],
    where: 'id = ?',
    whereArgs: <Object>[generationId],
  )).single;
  return row['merged_text'] as String;
}
