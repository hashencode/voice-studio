import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/shared/service/ephemeral_share_artifact_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'builds a bounded zip and reports failed entries without partials',
    () async {
      final root = await Directory.systemTemp.createTemp('ephemeral-share-');
      addTearDown(() => root.delete(recursive: true));
      final service = EphemeralShareArtifactService(
        rootDirectory: root,
        now: () => DateTime.fromMillisecondsSinceEpoch(1_750_000_000_000),
      );

      final result = await service.buildZip(
        baseName: '批量导出',
        entries: <EphemeralArchiveEntry>[
          EphemeralArchiveEntry(
            id: 'one',
            name: '音频一.md',
            write: (File target) => target.writeAsString('# one'),
          ),
          EphemeralArchiveEntry(
            id: 'two',
            name: '音频二.md',
            write: (_) async => throw const EphemeralArchiveEntryException(
              'transcript_unavailable',
            ),
          ),
        ],
        buildManifest: (entries) => '{"entries":${entries.length}}',
      );

      expect(result.artifact, isNotNull);
      expect(
        result.entries.singleWhere((entry) => entry.id == 'one').succeeded,
        isTrue,
      );
      expect(
        result.entries.singleWhere((entry) => entry.id == 'two').errorCode,
        'transcript_unavailable',
      );
      final archive = ZipDecoder().decodeBytes(
        await File(result.artifact!.path).readAsBytes(),
      );
      expect(
        archive.files.map((file) => file.name),
        containsAll(<String>['音频一.md', 'manifest.json']),
      );
      expect(archive.files.map((file) => file.name), isNot(contains('音频二.md')));
      expect(
        await root
            .list(recursive: true)
            .where((entity) => entity.path.endsWith('.partial'))
            .toList(),
        isEmpty,
      );
    },
  );

  test('rejects unsafe and duplicate normalized entry names', () async {
    final root = await Directory.systemTemp.createTemp('ephemeral-names-');
    addTearDown(() => root.delete(recursive: true));
    final service = EphemeralShareArtifactService(rootDirectory: root);

    for (final unsafe in <String>[
      '../secret.txt',
      '/absolute.txt',
      r'a\b.txt',
    ]) {
      await expectLater(
        service.buildZip(
          baseName: 'unsafe',
          entries: <EphemeralArchiveEntry>[
            EphemeralArchiveEntry(
              id: unsafe,
              name: unsafe,
              write: (target) => target.writeAsString('unsafe'),
            ),
          ],
          buildManifest: (_) => '{}',
        ),
        throwsFormatException,
      );
    }

    await expectLater(
      service.buildZip(
        baseName: 'duplicate',
        entries: <EphemeralArchiveEntry>[
          EphemeralArchiveEntry(
            id: 'one',
            name: 'Audio?.txt',
            write: (target) => target.writeAsString('one'),
          ),
          EphemeralArchiveEntry(
            id: 'two',
            name: 'audio_.txt',
            write: (target) => target.writeAsString('two'),
          ),
        ],
        buildManifest: (_) => '{}',
      ),
      throwsArgumentError,
    );
  });

  test(
    'cleanup removes only stale artifacts inside the dedicated root',
    () async {
      final root = await Directory.systemTemp.createTemp('ephemeral-cleanup-');
      addTearDown(() => root.delete(recursive: true));
      final stale = File('${root.path}/stale.zip')..writeAsStringSync('stale');
      final fresh = File('${root.path}/fresh.zip')..writeAsStringSync('fresh');
      final outside = File('${root.parent.path}/ephemeral-outside.txt')
        ..writeAsStringSync('outside');
      addTearDown(() async {
        if (await outside.exists()) await outside.delete();
      });
      final now = DateTime.fromMillisecondsSinceEpoch(1_750_000_000_000);
      stale.setLastModifiedSync(now.subtract(const Duration(hours: 25)));
      fresh.setLastModifiedSync(now.subtract(const Duration(hours: 23)));
      final service = EphemeralShareArtifactService(
        rootDirectory: root,
        now: () => now,
      );

      final removed = await service.cleanupStale();

      expect(removed, 1);
      expect(await stale.exists(), isFalse);
      expect(await fresh.exists(), isTrue);
      expect(await outside.exists(), isTrue);
    },
  );

  test(
    'share requests read-only access and launch failure cleans the artifact',
    () async {
      const channel = MethodChannel('ephemeral-share-test');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final root = await Directory.systemTemp.createTemp('ephemeral-channel-');
      addTearDown(() async {
        messenger.setMockMethodCallHandler(channel, null);
        await root.delete(recursive: true);
      });
      final service = EphemeralShareArtifactService(
        rootDirectory: root,
        channel: channel,
        now: () => DateTime.fromMillisecondsSinceEpoch(1_750_000_000_000),
      );
      final build = await service.buildZip(
        baseName: 'share',
        entries: <EphemeralArchiveEntry>[
          EphemeralArchiveEntry(
            id: 'one',
            name: 'one.txt',
            write: (target) => target.writeAsString('one'),
          ),
        ],
        buildManifest: (_) => '{}',
      );
      MethodCall? observed;
      messenger.setMockMethodCallHandler(channel, (call) async {
        observed = call;
        return <String, Object?>{'readOnly': true};
      });

      final receipt = await service.share(build.artifact!);

      expect(receipt.readOnly, isTrue);
      expect(observed?.method, 'shareEphemeralArtifact');
      expect(
        (observed?.arguments as Map<Object?, Object?>)['path'],
        build.artifact!.path,
      );

      messenger.setMockMethodCallHandler(channel, (_) async {
        throw PlatformException(code: 'chooser_failed', message: 'failed');
      });
      await expectLater(service.share(build.artifact!), throwsStateError);
      expect(await File(build.artifact!.path).exists(), isFalse);
    },
  );
}
