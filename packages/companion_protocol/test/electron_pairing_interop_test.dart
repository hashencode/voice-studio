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
    'Dart performs three-phase signed X25519 pairing with the TS receiver',
    () async {
      final library = await Isolate.resolvePackageUri(
        Uri.parse('package:companion_protocol/companion_protocol.dart'),
      );
      if (library == null || library.scheme != 'file') {
        fail('package unavailable');
      }
      final repositoryRoot = File.fromUri(library).parent.parent.parent.parent;
      final electronRoot = Directory(
        '${repositoryRoot.path}/apps/desktop-electron',
      );
      final fixture = File(
        '${electronRoot.path}/tests/fixtures/companion_pairing_host.ts',
      );
      final loader = File(
        '${electronRoot.path}/tests/fixtures/typescript_loader.mjs',
      );
      final temporary = await Directory.systemTemp.createTemp(
        'voice2text-pairing-interop-',
      );
      final process = await Process.start('node', <String>[
        '--no-warnings',
        '--experimental-strip-types',
        '--loader',
        loader.path,
        fixture.path,
        '${temporary.path}/transfers',
        'delay-final-ack',
      ], workingDirectory: electronRoot.path);
      final stderr = StringBuffer();
      final stderrDone = process.stderr
          .transform(utf8.decoder)
          .listen(stderr.write)
          .asFuture<void>();
      final stdoutLines = StreamIterator<String>(
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      try {
        if (!await stdoutLines.moveNext().timeout(
          const Duration(seconds: 15),
        )) {
          fail('pairing fixture did not publish its invite');
        }
        final line = stdoutLines.current;
        final invite = (jsonDecode(line) as Map).cast<String, Object?>();
        final identity = await CompanionIdentity.fromSeed(
          List<int>.generate(32, (index) => index + 7),
        );
        final failingPairer = CompanionSocketPairingClient(
          deviceId: 'mobile-pairing-1',
          deviceName: 'Dart Pairing Phone',
          identity: identity,
          pairingId: invite['pairingId']! as String,
          shortCode: invite['shortCode']! as String,
          targetDeviceId: invite['targetDeviceId']! as String,
          targetFingerprint: invite['targetFingerprint']! as String,
          targetIdentityPublicKey: SimplePublicKey(
            base64Decode(invite['targetIdentityPublicKey']! as String),
            type: KeyPairType.ed25519,
          ),
          targetEphemeralPublicKey: SimplePublicKey(
            base64Decode(invite['targetEphemeralPublicKey']! as String),
            type: KeyPairType.x25519,
          ),
          expiresAtMs: invite['expiresAtMs']! as int,
          persistPendingTrust: (_) async {
            throw const FileSystemException('simulated durable sink failure');
          },
        );
        await expectLater(
          failingPairer.pair(
            address: InternetAddress.loopbackIPv4,
            port: invite['port']! as int,
          ),
          throwsA(isA<FileSystemException>()),
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));
        process.kill(ProcessSignal.sigusr1);
        if (!await stdoutLines.moveNext().timeout(const Duration(seconds: 2))) {
          fail('pairing fixture did not publish commit status');
        }
        expect(
          (jsonDecode(stdoutLines.current) as Map)['commitCount'],
          0,
          reason: 'durable sink failure must happen before pairingCommit',
        );

        CompanionPeerTrust? pendingTrust;
        final pairer = CompanionSocketPairingClient(
          deviceId: 'mobile-pairing-1',
          deviceName: 'Dart Pairing Phone',
          identity: identity,
          pairingId: invite['pairingId']! as String,
          shortCode: invite['shortCode']! as String,
          targetDeviceId: invite['targetDeviceId']! as String,
          targetFingerprint: invite['targetFingerprint']! as String,
          targetIdentityPublicKey: SimplePublicKey(
            base64Decode(invite['targetIdentityPublicKey']! as String),
            type: KeyPairType.ed25519,
          ),
          targetEphemeralPublicKey: SimplePublicKey(
            base64Decode(invite['targetEphemeralPublicKey']! as String),
            type: KeyPairType.x25519,
          ),
          expiresAtMs: invite['expiresAtMs']! as int,
          persistPendingTrust: (trust) async => pendingTrust = trust,
          finalAcknowledgementTimeout: const Duration(milliseconds: 25),
        );
        await expectLater(
          pairer.pair(
            address: InternetAddress.loopbackIPv4,
            port: invite['port']! as int,
          ),
          throwsA(
            isA<CompanionProtocolException>().having(
              (error) => error.code,
              'code',
              'PAIRING_CONFIRMATION_UNKNOWN',
            ),
          ),
        );
        final trust = pendingTrust!;
        expect(trust.peerFingerprint, invite['targetFingerprint']);
        await Future<void>.delayed(const Duration(seconds: 1));

        final bytes = List<int>.generate(5000, (index) => index % 251);
        final source = File('${temporary.path}/probe.wav');
        await source.writeAsBytes(bytes, flush: true);
        final manifest = CompanionTransferManifest(
          transferId: 'pairing-probe-transfer-1',
          sourceAssetId: 'pairing-probe-asset-1',
          displayName: 'probe.wav',
          sizeBytes: bytes.length,
          wholeFileSha256: sha256.convert(bytes).toString(),
          chunkBytes: 4096,
          chunkCount: 2,
          createdAtMs: DateTime.now().millisecondsSinceEpoch,
        );
        final client = CompanionSocketClient(
          deviceId: 'mobile-pairing-1',
          deviceName: 'Dart Pairing Phone',
          deviceFingerprint: identity.fingerprint,
          targetDeviceId: invite['targetDeviceId']! as String,
          targetFingerprint: invite['targetFingerprint']! as String,
          targetIdentityPublicKey: pairer.targetIdentityPublicKey,
          sharedCredential: trust.sharedCredential,
        );
        await expectLater(
          client.sendFile(
            address: InternetAddress.loopbackIPv4,
            port: invite['port']! as int,
            source: source,
            manifest: manifest,
            maximumChunksThisConnection: 0,
          ),
          throwsA(
            isA<CompanionProtocolException>().having(
              (error) => error.code,
              'code',
              'SIMULATED_CONNECTION_LOSS',
            ),
          ),
        );
      } finally {
        await stdoutLines.cancel();
        process.kill(ProcessSignal.sigterm);
        final exitCode = await process.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            process.kill(ProcessSignal.sigkill);
            return process.exitCode;
          },
        );
        await stderrDone;
        await temporary.delete(recursive: true);
        if (exitCode != 0) fail('pairing fixture exited $exitCode: $stderr');
      }
    },
    timeout: const Timeout(Duration(seconds: 30)),
  );
}
