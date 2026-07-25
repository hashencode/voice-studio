import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:voice2text_flutter/features/records/service/meeting_deletion_coordinator.dart';

void main() {
  test('deletes only the dedicated managed export cache', () async {
    final root = Directory(
      p.join(Directory.systemTemp.path, 'voice2text', 'meetings', 'exports'),
    );
    await root.create(recursive: true);
    final managed = File(
      p.join(
        root.path,
        'deletion-boundary-${DateTime.now().microsecondsSinceEpoch}.txt',
      ),
    );
    await managed.writeAsString('owned');
    final outside = File(
      p.join(
        Directory.systemTemp.path,
        'voice2text-outside-${DateTime.now().microsecondsSinceEpoch}.txt',
      ),
    );
    await outside.writeAsString('not owned');
    addTearDown(() async {
      if (await managed.exists()) await managed.delete();
      if (await outside.exists()) await outside.delete();
    });

    final store = LocalMeetingFileStore();
    expect(await store.deleteIfPresent(managed.path), isTrue);
    expect(await managed.exists(), isFalse);
    expect(await store.deleteIfPresent(outside.path), isFalse);
    expect(await outside.exists(), isTrue);
  });

  test('rejects traversal that escapes the managed export cache', () async {
    final root = p.join(
      Directory.systemTemp.path,
      'voice2text',
      'meetings',
      'exports',
    );
    final escaped = p.join(root, '..', '..', '..', 'outside.txt');
    expect(await LocalMeetingFileStore().deleteIfPresent(escaped), isFalse);
  });
}
