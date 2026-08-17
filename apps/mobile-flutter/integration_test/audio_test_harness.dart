import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

class AudioIntegrationHarness {
  AudioIntegrationHarness._({
    required this.database,
    required this.appDatabase,
    required this.root,
    required this.audioFile,
  });

  final Database database;
  final AppDatabase appDatabase;
  final Directory root;
  final File audioFile;

  static Future<AudioIntegrationHarness> create(String name) async {
    final root = await Directory.systemTemp.createTemp('voice2text-$name-');
    final audio = File(p.join(root.path, 'audio.wav'));
    await audio.writeAsBytes(const <int>[82, 73, 70, 70]);
    final database = await openDatabase(
      p.join(root.path, '$name.db'),
      version: 1,
      onConfigure: (db) => db.execute('PRAGMA foreign_keys = ON'),
      onCreate: (db, _) => AppDatabase.createCurrentSchema(db),
    );
    return AudioIntegrationHarness._(
      database: database,
      appDatabase: AppDatabase.forTesting(database),
      root: root,
      audioFile: audio,
    );
  }

  Future<void> dispose() async {
    await database.close();
    if (await root.exists()) await root.delete(recursive: true);
  }
}
