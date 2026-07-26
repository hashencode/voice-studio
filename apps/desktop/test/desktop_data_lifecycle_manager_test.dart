import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/lifecycle/desktop_data_lifecycle_manager.dart';

void main() {
  test(
    'cleans bounded expired artifacts and preserves fresh or external data',
    () async {
      final root = await Directory.systemTemp.createTemp('desktop-lifecycle-');
      addTearDown(() async {
        if (await root.exists()) await root.delete(recursive: true);
      });
      final now = DateTime.utc(2026, 7, 26, 12);
      final staging = Directory('${root.path}/imports/staging')
        ..createSync(recursive: true);
      final sidecars = Directory('${root.path}/processing/jobs')
        ..createSync(recursive: true);
      final shares = Directory('${root.path}/sharing/ephemeral')
        ..createSync(recursive: true);
      final transfers = Directory('${root.path}/companion')
        ..createSync(recursive: true);
      final old = now.subtract(const Duration(hours: 25));
      final expiredImport = File('${staging.path}/old.partial')
        ..writeAsStringSync('old')
        ..setLastModifiedSync(old);
      final freshImport = File('${staging.path}/fresh.partial')
        ..writeAsStringSync('fresh');
      freshImport.setLastModifiedSync(now);
      final expiredSidecar = Directory('${sidecars.path}/old-job')
        ..createSync();
      final touch = await Process.run('/usr/bin/touch', <String>[
        '-t',
        '202607251000',
        expiredSidecar.path,
      ]);
      expect(touch.exitCode, 0);
      final external = File('${root.path}/external.txt')
        ..writeAsStringSync('keep')
        ..setLastModifiedSync(old);
    Link('${shares.path}/old-link').createSync(external.path);
      final bytes = utf8.encode('interrupted media');
      final manifest = CompanionTransferManifest(
        transferId: 'expired-transfer-1',
        sourceAssetId: 'source-1',
        displayName: 'meeting.wav',
        sizeBytes: bytes.length,
        wholeFileSha256: sha256.convert(bytes).toString(),
        chunkBytes: 4096,
        chunkCount: 1,
        createdAtMs: now
            .subtract(const Duration(days: 8))
            .millisecondsSinceEpoch,
      );
      final store = FileCompanionTransferStore(root: transfers);
      await store.begin(manifest);
      var databaseExpired = false;
      final manager = DesktopDataLifecycleManager(
        importStagingRoot: staging,
        sidecarWorkspaceRoot: sidecars,
        ephemeralShareRoot: shares,
        companionTransferRoot: transfers,
        loadStaleCompanionTransfers: (_) async => <CompanionTransferManifest>[
          manifest,
        ],
        expireCompanionTransfer: (_) async => databaseExpired = true,
        clock: () => now,
      );

      final report = await manager.cleanup();

      expect(report.failures, 0);
      expect(report.deletedImportStagingEntries, 1);
      expect(report.deletedSidecarEntries, 1);
      expect(report.deletedShareEntries, 1);
      expect(report.expiredCompanionTransfers, 1);
      expect(await expiredImport.exists(), isFalse);
      expect(await freshImport.exists(), isTrue);
      expect(await external.exists(), isTrue);
      expect(databaseExpired, isTrue);
      expect(await store.checkpointFor(manifest), isNull);
    },
  );
}
