import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../../app/contracts/audio_contract.dart';

typedef EphemeralArchiveEntryWriter = Future<void> Function(File target);
typedef EphemeralArchiveManifestBuilder =
    String Function(List<EphemeralArchiveEntryResult> entries);

class EphemeralArchiveEntryException implements Exception {
  const EphemeralArchiveEntryException(this.code);

  final String code;
}

class EphemeralArchiveEntry {
  const EphemeralArchiveEntry({
    required this.id,
    required this.name,
    required this.write,
  });

  final String id;
  final String name;
  final EphemeralArchiveEntryWriter write;
}

class EphemeralArchiveEntryResult {
  const EphemeralArchiveEntryResult({
    required this.id,
    required this.name,
    required this.succeeded,
    this.errorCode,
  });

  final String id;
  final String name;
  final bool succeeded;
  final String? errorCode;
}

class EphemeralShareArtifact {
  const EphemeralShareArtifact({
    required this.path,
    required this.displayName,
    required this.bytes,
    required this.createdAtMs,
  });

  final String path;
  final String displayName;
  final int bytes;
  final int createdAtMs;
}

class EphemeralArchiveBuildResult {
  const EphemeralArchiveBuildResult({
    required this.artifact,
    required this.entries,
  });

  final EphemeralShareArtifact? artifact;
  final List<EphemeralArchiveEntryResult> entries;
}

class EphemeralShareReceipt {
  const EphemeralShareReceipt({required this.path, required this.readOnly});

  final String path;
  final bool readOnly;
}

class EphemeralShareArtifactService {
  EphemeralShareArtifactService({
    Directory? rootDirectory,
    MethodChannel? channel,
    DateTime Function()? now,
    this.ttl = const Duration(hours: 24),
  }) : _rootDirectory = rootDirectory,
       _channel = channel ?? const MethodChannel(AudioContract.recorderChannel),
       _now = now ?? DateTime.now;

  final Directory? _rootDirectory;
  final MethodChannel _channel;
  final DateTime Function() _now;
  final Duration ttl;

  Future<EphemeralArchiveBuildResult> buildZip({
    required String baseName,
    required List<EphemeralArchiveEntry> entries,
    required EphemeralArchiveManifestBuilder buildManifest,
  }) async {
    final normalizedEntries = _validatedEntries(entries);
    final root = await _root();
    await root.create(recursive: true);
    final staging = await root.createTemp('.staging-');
    final results = <EphemeralArchiveEntryResult>[];
    try {
      for (final entry in normalizedEntries) {
        final target = File(p.join(staging.path, entry.name));
        try {
          await entry.write(target);
          if (!await target.exists() || await target.length() == 0) {
            throw const EphemeralArchiveEntryException('entry_empty');
          }
          results.add(
            EphemeralArchiveEntryResult(
              id: entry.id,
              name: entry.name,
              succeeded: true,
            ),
          );
        } on EphemeralArchiveEntryException catch (error) {
          await _deleteFileBestEffort(target);
          results.add(
            EphemeralArchiveEntryResult(
              id: entry.id,
              name: entry.name,
              succeeded: false,
              errorCode: error.code,
            ),
          );
        } catch (_) {
          await _deleteFileBestEffort(target);
          results.add(
            EphemeralArchiveEntryResult(
              id: entry.id,
              name: entry.name,
              succeeded: false,
              errorCode: 'entry_write_failed',
            ),
          );
        }
      }

      final successful = results.where((entry) => entry.succeeded).toList();
      if (successful.isEmpty) {
        return EphemeralArchiveBuildResult(
          artifact: null,
          entries: List.unmodifiable(results),
        );
      }

      final manifest = File(p.join(staging.path, 'manifest.json'));
      await manifest.writeAsString(
        buildManifest(List.unmodifiable(results)),
        flush: true,
      );
      final createdAtMs = _now().millisecondsSinceEpoch;
      final safeBaseName = normalizeSafeBasename(baseName);
      final displayName = '$safeBaseName-$createdAtMs.zip';
      final target = await _uniqueTarget(root, displayName);
      final partial = File('${target.path}.partial');
      final encoder = ZipFileEncoder();
      var opened = false;
      try {
        encoder.create(partial.path);
        opened = true;
        for (final entry in successful) {
          await encoder.addFile(
            File(p.join(staging.path, entry.name)),
            entry.name,
          );
        }
        await encoder.addFile(manifest, 'manifest.json');
        await encoder.close();
        opened = false;
        await partial.rename(target.path);
      } catch (_) {
        if (opened) {
          try {
            await encoder.close();
          } catch (_) {
            // Preserve the original archive failure.
          }
        }
        await _deleteFileBestEffort(partial);
        await _deleteFileBestEffort(target);
        rethrow;
      }

      return EphemeralArchiveBuildResult(
        artifact: EphemeralShareArtifact(
          path: target.path,
          displayName: p.basename(target.path),
          bytes: await target.length(),
          createdAtMs: createdAtMs,
        ),
        entries: List.unmodifiable(results),
      );
    } finally {
      await _deleteDirectoryBestEffort(staging);
    }
  }

  Future<EphemeralShareReceipt> share(EphemeralShareArtifact artifact) async {
    final root = await _root();
    final file = File(p.normalize(artifact.path));
    if (!await file.exists() || !_isWithin(file, root)) {
      throw StateError('临时分享文件不存在或不属于允许目录');
    }
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(
        'shareEphemeralArtifact',
        <String, Object?>{
          'path': file.path,
          'displayName': artifact.displayName,
        },
      );
      final readOnly = raw?['readOnly'] as bool? ?? false;
      if (!readOnly) {
        throw PlatformException(
          code: 'EPHEMERAL_SHARE_RESULT_INVALID',
          message: '系统分享未返回只读授权',
        );
      }
      return EphemeralShareReceipt(path: file.path, readOnly: true);
    } catch (error) {
      await discard(file.path);
      if (error is PlatformException) {
        throw StateError(error.message ?? '无法打开系统分享');
      }
      rethrow;
    }
  }

  Future<bool> discard(String path) async {
    final root = await _root();
    final file = File(p.normalize(path));
    if (!_isWithin(file, root)) return false;
    try {
      if (await file.exists()) await file.delete();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<int> cleanupStale() async {
    final root = await _root();
    if (!await root.exists()) return 0;
    final threshold = _now().subtract(ttl);
    var removed = 0;
    await for (final entity in root.list(followLinks: false)) {
      try {
        final modified = await entity.stat().then((stat) => stat.modified);
        if (!modified.isBefore(threshold)) continue;
        if (entity is Directory) {
          await entity.delete(recursive: true);
        } else {
          await entity.delete();
        }
        removed += 1;
      } catch (_) {
        // Cleanup is best effort and never broadens beyond the dedicated root.
      }
    }
    return removed;
  }

  static String normalizeSafeBasename(String input) {
    final trimmed = input.trim();
    if (trimmed.isEmpty ||
        p.isAbsolute(trimmed) ||
        trimmed.contains('/') ||
        trimmed.contains(r'\') ||
        p.basename(trimmed) != trimmed ||
        trimmed == '.' ||
        trimmed == '..') {
      throw const FormatException('ZIP entry must be a safe basename');
    }
    final safe = trimmed
        .replaceAll(RegExp(r'[^\p{L}\p{N}._-]+', unicode: true), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^[._]+|[._]+$'), '');
    if (safe.isEmpty || safe == '.' || safe == '..') {
      throw const FormatException(
        'ZIP entry basename is empty after normalization',
      );
    }
    return safe.length <= 120 ? safe : safe.substring(0, 120);
  }

  List<EphemeralArchiveEntry> _validatedEntries(
    List<EphemeralArchiveEntry> entries,
  ) {
    final names = <String>{'manifest.json'};
    return entries
        .map((entry) {
          final name = normalizeSafeBasename(entry.name);
          if (!names.add(name.toLowerCase())) {
            throw ArgumentError.value(
              entry.name,
              'entries',
              'duplicate ZIP entry',
            );
          }
          return EphemeralArchiveEntry(
            id: entry.id,
            name: name,
            write: entry.write,
          );
        })
        .toList(growable: false);
  }

  Future<Directory> _root() async {
    final configured = _rootDirectory;
    if (configured != null) return configured.absolute;
    final temporary = await getTemporaryDirectory();
    return Directory(
      p.join(temporary.path, 'voice2text', 'sharing', 'ephemeral'),
    ).absolute;
  }

  Future<File> _uniqueTarget(Directory root, String displayName) async {
    final extension = p.extension(displayName);
    final stem = p.basenameWithoutExtension(displayName);
    var candidate = File(p.join(root.path, displayName));
    var suffix = 2;
    while (await candidate.exists()) {
      candidate = File(p.join(root.path, '$stem-$suffix$extension'));
      suffix += 1;
    }
    return candidate;
  }

  bool _isWithin(File file, Directory root) {
    final normalizedRoot = p.normalize(root.absolute.path);
    final normalizedFile = p.normalize(file.absolute.path);
    return normalizedFile != normalizedRoot &&
        p.isWithin(normalizedRoot, normalizedFile);
  }

  Future<void> _deleteFileBestEffort(File file) async {
    try {
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  Future<void> _deleteDirectoryBestEffort(Directory directory) async {
    try {
      if (await directory.exists()) await directory.delete(recursive: true);
    } catch (_) {}
  }
}
