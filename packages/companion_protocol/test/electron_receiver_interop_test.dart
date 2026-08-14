import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:test/test.dart';

void main() {
  test(
    'Dart sender resumes against the TypeScript Electron receiver',
    () async {
      final companionLibrary = await Isolate.resolvePackageUri(
        Uri.parse('package:companion_protocol/companion_protocol.dart'),
      );
      if (companionLibrary == null || companionLibrary.scheme != 'file') {
        fail('companion_protocol package URI is unavailable');
      }
      final packageRoot = File.fromUri(companionLibrary).parent.parent;
      final repositoryRoot = packageRoot.parent.parent;
      final electronRoot = Directory(
        '${repositoryRoot.path}/apps/desktop-electron',
      );
      final fixture = File(
        '${electronRoot.path}/tests/fixtures/companion_receiver_host.ts',
      );
      final loader = File(
        '${electronRoot.path}/tests/fixtures/typescript_loader.mjs',
      );
      expect(fixture.existsSync(), isTrue);
      expect(loader.existsSync(), isTrue);

      final temporary = await Directory.systemTemp.createTemp(
        'voice2text-dart-electron-interop-',
      );
      final transferRoot = Directory('${temporary.path}/transfers');
      final source = File('${temporary.path}/meeting.wav');
      final bytes = List<int>.generate(5000, (index) => index % 251);
      await source.writeAsBytes(bytes, flush: true);
      final credential = List<int>.generate(32, (index) => index + 1);
      final receiverArguments = <String>[
        '--no-warnings',
        '--experimental-strip-types',
        '--loader',
        loader.path,
        fixture.path,
        transferRoot.path,
      ];
      expect(
        receiverArguments.join(' '),
        isNot(contains(base64Encode(credential))),
      );
      final process = await Process.start(
        'node',
        receiverArguments,
        workingDirectory: electronRoot.path,
      );
      process.stdin.add(credential);
      await process.stdin.close();
      final stderr = StringBuffer();
      final stderrDone = process.stderr
          .transform(utf8.decoder)
          .listen(stderr.write)
          .asFuture<void>();
      try {
        final line = await process.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .first
            .timeout(const Duration(seconds: 15));
        final ready = (jsonDecode(line) as Map).cast<String, Object?>();
        final port = ready['port']! as int;
        final targetFingerprint = ready['identityFingerprint']! as String;
        final targetIdentityPublicKey = SimplePublicKey(
          base64Decode(ready['identityPublicKey']! as String),
          type: KeyPairType.ed25519,
        );
        final manifest = CompanionTransferManifest(
          transferId: 'transfer-interop-1',
          sourceAssetId: 'asset-interop-1',
          displayName: 'meeting.wav',
          sizeBytes: bytes.length,
          wholeFileSha256: sha256.convert(bytes).toString(),
          chunkBytes: 4096,
          chunkCount: 2,
          createdAtMs: DateTime.now().millisecondsSinceEpoch,
        );
        final client = CompanionSocketClient(
          deviceId: 'mobile-interop-1',
          deviceName: 'Dart Interop Phone',
          deviceFingerprint: List<String>.filled(32, 'M').join(),
          targetDeviceId: 'desktop-interop-1',
          targetFingerprint: targetFingerprint,
          targetIdentityPublicKey: targetIdentityPublicKey,
          sharedCredential: credential,
        );

        await expectLater(
          client.sendFile(
            address: InternetAddress.loopbackIPv4,
            port: port,
            source: source,
            manifest: manifest,
            maximumChunksThisConnection: 1,
          ),
          throwsA(
            isA<CompanionProtocolException>().having(
              (error) => error.code,
              'code',
              'SIMULATED_CONNECTION_LOSS',
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));
        final progress = <int>[];
        final receipt = await client.sendFile(
          address: InternetAddress.loopbackIPv4,
          port: port,
          source: source,
          manifest: manifest,
          onProgress: (sent, _) => progress.add(sent),
        );
        expect(progress, <int>[904]);
        expect(receipt.transferId, manifest.transferId);
        expect(receipt.wholeFileSha256, manifest.wholeFileSha256);
        expect(receipt.desktopDeviceId, 'desktop-interop-1');
        expect(receipt.desktopRecordingId, 99);
      } finally {
        process.kill(ProcessSignal.sigterm);
        final exitCode = await process.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            process.kill(ProcessSignal.sigkill);
            return process.exitCode;
          },
        );
        await stderrDone;
        final processFailure = exitCode == 0
            ? null
            : 'Electron receiver fixture exited $exitCode: $stderr';
        await temporary.delete(recursive: true);
        if (processFailure != null) fail(processFailure);
      }
    },
    timeout: const Timeout(Duration(seconds: 30)),
  );
}
