import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'app_database.dart';
import 'audio_storage_contract.dart';

typedef DesktopSupportDirectoryProvider = Future<Directory> Function();

class DesktopDatabaseFactory {
  const DesktopDatabaseFactory({
    this.supportDirectoryProvider = getApplicationSupportDirectory,
    this.databaseName = AudioStorageContract.databaseFileName,
  });

  final DesktopSupportDirectoryProvider supportDirectoryProvider;
  final String databaseName;

  Future<AppDatabase> create() async {
    sqfliteFfiInit();
    final supportDirectory = await supportDirectoryProvider();
    final databaseDirectory = Directory(
      p.join(supportDirectory.path, 'database'),
    );
    await databaseDirectory.create(recursive: true);
    return AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => databaseDirectory.path,
      databaseName: databaseName,
    );
  }
}
