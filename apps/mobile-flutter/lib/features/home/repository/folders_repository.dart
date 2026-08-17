import '../../../data/sqlite/app_database.dart';
import '../model/folder_entity.dart';

class FoldersRepository {
  FoldersRepository({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<List<FolderEntity>> listFolders() async {
    final db = await _database.database;
    final rows = await db.query(
      'folders',
      orderBy: 'created_at_ms DESC, name ASC',
    );
    return rows.map(FolderEntity.fromMap).toList();
  }

  Future<void> createFolder(String name) async {
    final db = await _database.database;
    await db.insert('folders', <String, Object?>{
      'name': name,
      'created_at_ms': DateTime.now().millisecondsSinceEpoch,
      'is_favorite': 0,
    });
  }
}
