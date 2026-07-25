import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

void main() {
  test('v11 meeting asset migration preserves legacy recordings', () async {
    sqfliteFfiInit();
    final database = await databaseFactoryFfi.openDatabase(
      inMemoryDatabasePath,
    );
    addTearDown(database.close);
    await database.execute('''
      CREATE TABLE recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        display_name TEXT,
        group_name TEXT,
        deleted_at_ms INTEGER,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        duration_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    ''');
    await database.insert('recordings', <String, Object?>{
      'file_path': '/legacy/meeting.m4a',
      'display_name': '旧会议',
      'duration_ms': 1000,
      'created_at_ms': 123,
    });

    await AppDatabase.migrateManagedMeetingAssets(database);
    await AppDatabase.migrateManagedMeetingAssets(database);

    final columns = await database.rawQuery('PRAGMA table_info(recordings)');
    final tables = await database.rawQuery(
      "SELECT name FROM sqlite_master "
      "WHERE type = 'table' AND name = 'meeting_assets'",
    );
    final rows = await database.query('recordings');

    expect(
      columns.map((row) => row['name']),
      containsAll(<String>[
        'asset_kind',
        'fingerprint_sha256',
        'source_display_name',
        'deletion_state',
      ]),
    );
    expect(tables, hasLength(1));
    expect(rows, hasLength(1));
    expect(rows.single['file_path'], '/legacy/meeting.m4a');
    expect(rows.single['asset_kind'], 'recording');
    expect(rows.single['deletion_state'], 'active');
  });
}
