import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';

Future<({Database database, AppDatabase appDatabase})>
openRecordingTestDatabase() async {
  sqfliteFfiInit();
  final Database database = await databaseFactoryFfi.openDatabase(
    inMemoryDatabasePath,
  );
  await database.execute('PRAGMA foreign_keys = ON');
  await AppDatabase.createCurrentSchema(database);
  return (database: database, appDatabase: AppDatabase.forTesting(database));
}
