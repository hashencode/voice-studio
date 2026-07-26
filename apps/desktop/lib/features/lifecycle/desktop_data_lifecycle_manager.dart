import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';

typedef StaleCompanionTransferLoader =
    Future<List<CompanionTransferManifest>> Function(int cutoffMs);
typedef CompanionTransferExpiry =
    Future<void> Function(CompanionTransferManifest manifest);

class DesktopDataLifecycleReport {
  const DesktopDataLifecycleReport({
    required this.deletedImportStagingEntries,
    required this.deletedSidecarEntries,
    required this.deletedShareEntries,
    required this.expiredCompanionTransfers,
    required this.failures,
  });

  final int deletedImportStagingEntries;
  final int deletedSidecarEntries;
  final int deletedShareEntries;
  final int expiredCompanionTransfers;
  final int failures;
}

class DesktopDataLifecycleManager {
  const DesktopDataLifecycleManager({
    required this.importStagingRoot,
    required this.sidecarWorkspaceRoot,
    required this.ephemeralShareRoot,
    required this.companionTransferRoot,
    required this.loadStaleCompanionTransfers,
    required this.expireCompanionTransfer,
    this.clock = DateTime.now,
  });

  static const failedArtifactRetention = Duration(hours: 24);
  static const interruptedTransferRetention = Duration(days: 7);

  final Directory importStagingRoot;
  final Directory sidecarWorkspaceRoot;
  final Directory ephemeralShareRoot;
  final Directory companionTransferRoot;
  final StaleCompanionTransferLoader loadStaleCompanionTransfers;
  final CompanionTransferExpiry expireCompanionTransfer;
  final DateTime Function() clock;

  Future<DesktopDataLifecycleReport> cleanup() async {
    final now = clock();
    var failures = 0;
    final importDeleted = await _deleteExpiredChildren(
      importStagingRoot,
      now.subtract(failedArtifactRetention),
      onFailure: () => failures++,
    );
    final sidecarDeleted = await _deleteExpiredChildren(
      sidecarWorkspaceRoot,
      now.subtract(failedArtifactRetention),
      onFailure: () => failures++,
    );
    final shareDeleted = await _deleteExpiredChildren(
      ephemeralShareRoot,
      now.subtract(failedArtifactRetention),
      onFailure: () => failures++,
    );
    var expiredTransfers = 0;
    try {
      final cutoff = now
          .subtract(interruptedTransferRetention)
          .millisecondsSinceEpoch;
      final stale = await loadStaleCompanionTransfers(cutoff);
      final fileStore = FileCompanionTransferStore(root: companionTransferRoot);
      for (final manifest in stale) {
        try {
          await fileStore.cancel(manifest);
          await expireCompanionTransfer(manifest);
          expiredTransfers++;
        } on Object {
          failures++;
        }
      }
    } on Object {
      failures++;
    }
    return DesktopDataLifecycleReport(
      deletedImportStagingEntries: importDeleted,
      deletedSidecarEntries: sidecarDeleted,
      deletedShareEntries: shareDeleted,
      expiredCompanionTransfers: expiredTransfers,
      failures: failures,
    );
  }

  Future<int> _deleteExpiredChildren(
    Directory root,
    DateTime cutoff, {
    required void Function() onFailure,
  }) async {
    if (!await root.exists()) return 0;
    final rootType = await FileSystemEntity.type(root.path, followLinks: false);
    if (rootType != FileSystemEntityType.directory) {
      onFailure();
      return 0;
    }
    var deleted = 0;
    await for (final entry in root.list(followLinks: false)) {
      try {
        final type = await FileSystemEntity.type(
          entry.path,
          followLinks: false,
        );
        final modified = type == FileSystemEntityType.link
            ? await Link(entry.path).stat().then((stat) => stat.modified)
            : (await entry.stat()).modified;
        if (modified.isAfter(cutoff)) continue;
        if (type == FileSystemEntityType.directory) {
          await Directory(entry.path).delete(recursive: true);
        } else if (type == FileSystemEntityType.link) {
          await Link(entry.path).delete();
        } else if (type == FileSystemEntityType.file) {
          await File(entry.path).delete();
        }
        deleted++;
      } on Object {
        onFailure();
      }
    }
    return deleted;
  }
}
