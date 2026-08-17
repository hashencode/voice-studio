import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'physical Android sends, resumes, dedupes, and retains source',
    (tester) async {
      const host = String.fromEnvironment('U8_LAN_HOST');
      const port = int.fromEnvironment('U8_LAN_PORT');
      const runId = String.fromEnvironment('U8_RUN_ID', defaultValue: '1');
      expect(host, isNotEmpty);
      expect(port, greaterThan(0));

      final root = await Directory.systemTemp.createTemp('u8-android-lan-');
      addTearDown(() async {
        if (await root.exists()) await root.delete(recursive: true);
      });
      final source = File('${root.path}/u8-large-audio.wav');
      final sink = source.openWrite();
      const marker = 'VOICE2TEXT_U8_SECRET_MEETING_CONTENT_';
      final block = <int>[
        ...marker.codeUnits,
        ...List<int>.generate(
          64 * 1024 - marker.length,
          (index) => index % 251,
        ),
      ];
      for (var index = 0; index < 384; index++) {
        sink.add(block);
      }
      await sink.flush();
      await sink.close();
      final size = await source.length();
      expect(size, 24 * 1024 * 1024);
      final digest = await sha256.bind(source.openRead()).first;
      final manifest = CompanionTransferManifest(
        transferId: 'u8-physical-transfer-$runId',
        sourceAssetId: 'u8-physical-recording-$runId',
        displayName: 'u8-large-audio.wav',
        sizeBytes: size,
        wholeFileSha256: digest.toString(),
        chunkBytes: companionDefaultChunkBytes,
        chunkCount: size ~/ companionDefaultChunkBytes,
        createdAtMs: 1,
      );
      final client = CompanionSocketClient(
        deviceId: 'u8-android',
        deviceName: 'U8 Physical Android',
        deviceFingerprint: 'A'.padRight(32, 'A'),
        targetDeviceId: 'u8-desktop',
        targetFingerprint: 'D'.padRight(32, 'D'),
        sharedCredential: List<int>.generate(32, (index) => index),
      );

      await expectLater(
        client.sendFile(
          address: InternetAddress(host),
          port: port,
          source: source,
          manifest: manifest,
          maximumChunksThisConnection: 25,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'SIMULATED_CONNECTION_LOSS',
          ),
        ),
      );
      await Future<void>.delayed(const Duration(seconds: 1));
      var resumedBytes = 0;
      final receipt = await client.sendFile(
        address: InternetAddress(host),
        port: port,
        source: source,
        manifest: manifest,
        onProgress: (sent, _) => resumedBytes = sent,
      );
      expect(resumedBytes, size - 25 * companionDefaultChunkBytes);
      expect(receipt.wholeFileSha256, digest.toString());
      expect(receipt.sizeBytes, size);
      expect(receipt.desktopRecordingId, 7008);
      expect(await source.exists(), isTrue);
      await Future<void>.delayed(const Duration(seconds: 1));
      final duplicate = await client.sendFile(
        address: InternetAddress(host),
        port: port,
        source: source,
        manifest: manifest,
      );
      expect(duplicate.receiptId, receipt.receiptId);
      expect(duplicate.desktopRecordingId, receipt.desktopRecordingId);
      expect(await source.exists(), isTrue);
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
