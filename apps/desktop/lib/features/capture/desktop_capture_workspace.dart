import 'dart:io';

import 'package:path/path.dart' as p;

class DesktopCaptureWorkspace {
  DesktopCaptureWorkspace(this.root);

  static final RegExp _sessionId = RegExp(r'^session-[a-zA-Z0-9-]{12,120}$');

  final Directory root;

  Future<Directory> createSession(String sessionId) async {
    _requireSessionId(sessionId);
    await root.create(recursive: true);
    final candidate = Directory(p.join(root.path, sessionId));
    _requireChild(candidate.path);
    final type = await FileSystemEntity.type(
      candidate.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.link ||
        (type != FileSystemEntityType.notFound &&
            type != FileSystemEntityType.directory)) {
      throw const FileSystemException(
        'Capture session workspace is not a private directory',
      );
    }
    await candidate.create();
    return candidate;
  }

  Future<List<Directory>> sessionDirectories() async {
    if (!await root.exists()) {
      return const <Directory>[];
    }
    final values = <Directory>[];
    await for (final entity in root.list(followLinks: false)) {
      if (entity is! Directory) {
        continue;
      }
      final sessionId = p.basename(entity.path);
      if (!_sessionId.hasMatch(sessionId)) {
        continue;
      }
      _requireChild(entity.path);
      values.add(entity);
    }
    values.sort((left, right) => left.path.compareTo(right.path));
    return values;
  }

  Future<void> discardSession(String sessionId) async {
    _requireSessionId(sessionId);
    final directory = Directory(p.join(root.path, sessionId));
    _requireChild(directory.path);
    final type = await FileSystemEntity.type(
      directory.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.notFound) {
      return;
    }
    if (type != FileSystemEntityType.directory) {
      throw const FileSystemException(
        'Capture discard target is not a session directory',
      );
    }
    await directory.delete(recursive: true);
  }

  void _requireChild(String candidate) {
    final canonicalRoot = p.canonicalize(root.absolute.path);
    final canonicalCandidate = p.canonicalize(File(candidate).absolute.path);
    if (!p.isWithin(canonicalRoot, canonicalCandidate)) {
      throw const FileSystemException(
        'Capture workspace path escaped its private root',
      );
    }
  }

  static void _requireSessionId(String sessionId) {
    if (!_sessionId.hasMatch(sessionId)) {
      throw const FormatException('Invalid desktop capture session ID');
    }
  }
}
