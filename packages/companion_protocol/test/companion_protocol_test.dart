import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';

void main() {
  group('pairing and encrypted session', () {
    test('binds both identities and rejects fingerprint changes', () async {
      final initiator = await CompanionIdentity.fromSeed(
        List<int>.generate(32, (index) => index),
      );
      final responder = await CompanionIdentity.fromSeed(
        List<int>.generate(32, (index) => 255 - index),
      );
      final transcript = CompanionPairingTranscript(
        pairingId: 'pair-1',
        initiatorDeviceId: 'android-1',
        initiatorFingerprint: initiator.fingerprint,
        responderDeviceId: 'desktop-1',
        responderFingerprint: responder.fingerprint,
        shortCodeHash: CompanionPairingTranscript.hashShortCode(
          pairingId: 'pair-1',
          code: '123456',
        ),
        expiresAtMs: 2000,
        capabilities: const <String>[companionMediaTransferCapability],
      );
      final signed = CompanionSignedPairing(
        transcript: transcript,
        initiatorPublicKey: initiator.publicKey,
        initiatorSignature: await initiator.sign(transcript.canonicalBytes()),
        responderPublicKey: responder.publicKey,
        responderSignature: await responder.sign(transcript.canonicalBytes()),
      );
      await signed.verify();

      final trust = CompanionPeerTrust(
        peerDeviceId: 'desktop-1',
        peerFingerprint: responder.fingerprint,
        sharedCredential: List<int>.filled(32, 7),
        pairedAtMs: 1000,
      );
      expect(
        () => trust.requireUsable(
          presentedFingerprint: initiator.fingerprint,
          restoredFromBackup: false,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PEER_KEY_CHANGED',
          ),
        ),
      );
    });

    test('short code expires, locks brute force, and is single use', () {
      final expected = CompanionPairingTranscript.hashShortCode(
        pairingId: 'pair-2',
        code: '222222',
      );
      final guard = CompanionPairingGuard(
        expiresAtMs: 2000,
        maximumAttempts: 2,
      );
      for (final code in <String>['000000', '111111']) {
        expect(
          () => guard.verify(
            nowMs: 1000,
            expectedHash: expected,
            pairingId: 'pair-2',
            code: code,
          ),
          throwsA(isA<CompanionProtocolException>()),
        );
      }
      expect(
        () => guard.verify(
          nowMs: 1000,
          expectedHash: expected,
          pairingId: 'pair-2',
          code: '222222',
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PAIRING_LOCKED',
          ),
        ),
      );
      final expired = CompanionPairingGuard(expiresAtMs: 999);
      expect(
        () => expired.verify(
          nowMs: 1000,
          expectedHash: expected,
          pairingId: 'pair-2',
          code: '222222',
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PAIRING_EXPIRED',
          ),
        ),
      );
    });

    test('AES-GCM session rejects replay, tamper, and expiry', () async {
      final sessions = await CompanionSession.establish(
        sessionId: 'session-1',
        sharedCredential: List<int>.generate(32, (index) => index),
        initiatorNonce: List<int>.filled(32, 11),
        responderNonce: List<int>.filled(32, 22),
        expiresAtMs: 2000,
      );
      final sealed = await sessions.$1.seal(
        type: CompanionMessageType.capability,
        messageId: 'message-1',
        payload: CompanionCapability(
          maxChunkBytes: companionDefaultChunkBytes,
          maxSourceBytes: companionMaximumSourceBytes,
          resume: true,
          receipts: true,
        ).toJson(),
        nowMs: 1000,
      );
      final opened = await sessions.$2.open(sealed: sealed, nowMs: 1000);
      expect(opened.type, CompanionMessageType.capability);
      final binary = await sessions.$1.sealBytes(
        plaintext: <int>[1, 2, 3, 4],
        nowMs: 1000,
      );
      expect(await sessions.$2.openBytes(packet: binary, nowMs: 1000), <int>[
        1,
        2,
        3,
        4,
      ]);
      expect(
        () => sessions.$2.open(sealed: sealed, nowMs: 1000),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'REPLAY_REJECTED',
          ),
        ),
      );
      expect(
        () => sessions.$1.seal(
          type: CompanionMessageType.cancel,
          messageId: 'message-2',
          payload: const <String, Object?>{'reason': 'user'},
          nowMs: 2001,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'SESSION_EXPIRED',
          ),
        ),
      );
    });

    test('revoked and restored trust is rejected', () {
      final revoked = CompanionPeerTrust(
        peerDeviceId: 'desktop-1',
        peerFingerprint: 'A'.padRight(32, 'A'),
        sharedCredential: List<int>.filled(32, 1),
        pairedAtMs: 1,
        revokedAtMs: 2,
      );
      expect(
        () => revoked.requireUsable(
          presentedFingerprint: 'A'.padRight(32, 'A'),
          restoredFromBackup: false,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PEER_REVOKED',
          ),
        ),
      );
      final active = CompanionPeerTrust(
        peerDeviceId: 'desktop-1',
        peerFingerprint: 'A'.padRight(32, 'A'),
        sharedCredential: List<int>.filled(32, 1),
        pairedAtMs: 1,
      );
      expect(
        () => active.requireUsable(
          presentedFingerprint: 'A'.padRight(32, 'A'),
          restoredFromBackup: true,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'BACKUP_RESTORE_REPAIR_REQUIRED',
          ),
        ),
      );
    });
  });

  group('bounded media transfer', () {
    late Directory temporary;

    setUp(() async {
      temporary = await Directory.systemTemp.createTemp(
        'companion-protocol-test-',
      );
    });

    tearDown(() async {
      if (await temporary.exists()) {
        await temporary.delete(recursive: true);
      }
    });

    test('resumes only missing chunks and receipt is idempotent', () async {
      final bytes = utf8.encode('secure meeting media payload');
      final manifest = _manifest(bytes, chunkBytes: 4096);
      final store = FileCompanionTransferStore(root: temporary);
      var commits = 0;
      final receiver = CompanionTransferReceiver(
        store: store,
        desktopDeviceId: 'desktop-1',
        desktopDeviceName: 'Studio Mac',
        clockMs: () => 1234,
        signReceipt: (payload) async => base64Encode(
          sha256.convert(utf8.encode(jsonEncode(payload))).bytes,
        ),
        commitImport: (stagedPath, manifest) async {
          commits++;
          return (
            recordingId: 42,
            committedSha256: await sha256
                .bind(File(stagedPath).openRead())
                .first
                .then((value) => value.toString()),
          );
        },
      );

      var checkpoint = await receiver.acceptManifest(manifest);
      expect(checkpoint.missingChunks, <int>[0]);
      final chunk = CompanionChunk(
        transferId: manifest.transferId,
        index: 0,
        offset: 0,
        plaintextBytes: bytes.length,
        sha256: sha256.convert(bytes).toString(),
      );
      checkpoint = await receiver.acceptChunk(manifest, chunk, bytes);
      expect(checkpoint.missingChunks, isEmpty);
      final receipt = await receiver.commit(manifest);
      final duplicate = await receiver.commit(manifest);
      expect(receipt.desktopRecordingId, 42);
      expect(duplicate.receiptId, receipt.receiptId);
      expect(commits, 1);
    });

    test('chunk and whole-file hash mismatches never commit', () async {
      final bytes = utf8.encode('secure meeting media payload');
      final manifest = _manifest(bytes, chunkBytes: 4096);
      final store = FileCompanionTransferStore(root: temporary);
      var committed = false;
      final receiver = CompanionTransferReceiver(
        store: store,
        desktopDeviceId: 'desktop-1',
        desktopDeviceName: 'Studio Mac',
        signReceipt: (_) async => base64Encode(List<int>.filled(64, 1)),
        commitImport: (_, _) async {
          committed = true;
          return (recordingId: 1, committedSha256: manifest.wholeFileSha256);
        },
      );
      await receiver.acceptManifest(manifest);
      expect(
        () => receiver.acceptChunk(
          manifest,
          CompanionChunk(
            transferId: manifest.transferId,
            index: 0,
            offset: 0,
            plaintextBytes: bytes.length,
            sha256: '0'.padRight(64, '0'),
          ),
          bytes,
        ),
        throwsA(isA<CompanionProtocolException>()),
      );
      expect(committed, isFalse);
    });

    test(
      'rejects oversized metadata, offsets, and transfer conflicts',
      () async {
        expect(
          () => CompanionEnvelope(
            type: CompanionMessageType.error,
            messageId: 'message-1',
            sessionId: 'session-1',
            counter: 0,
            payload: <String, Object?>{
              'message': 'x'.padRight(companionMaximumMetadataBytes, 'x'),
            },
          ),
          throwsA(isA<CompanionProtocolException>()),
        );
        final bytes = utf8.encode('payload');
        final manifest = _manifest(bytes, chunkBytes: 4096);
        final store = FileCompanionTransferStore(root: temporary);
        await store.begin(manifest);
        final conflict = CompanionTransferManifest(
          transferId: manifest.transferId,
          sourceAssetId: manifest.sourceAssetId,
          displayName: manifest.displayName,
          sizeBytes: bytes.length,
          wholeFileSha256: '0'.padRight(64, '0'),
          chunkBytes: 4096,
          chunkCount: 1,
          createdAtMs: 1,
        );
        await expectLater(
          store.begin(conflict),
          throwsA(isA<CompanionProtocolException>()),
        );
      },
    );

    test('rejects symlink and hard-link chunk substitution', () async {
      final bytes = utf8.encode('payload');
      final manifest = _manifest(bytes, chunkBytes: 4096);
      final store = FileCompanionTransferStore(root: temporary);
      await store.begin(manifest);
      final transferDirectory = Directory(
        '${temporary.path}/${sha256.convert(utf8.encode(manifest.idempotencyKey))}',
      );
      final chunkPath = '${transferDirectory.path}/chunk-0.part';
      final external = File('${temporary.path}/external.bin');
      await external.writeAsBytes(bytes, flush: true);
      await Link(chunkPath).create(external.path);
      final chunk = CompanionChunk(
        transferId: manifest.transferId,
        index: 0,
        offset: 0,
        plaintextBytes: bytes.length,
        sha256: sha256.convert(bytes).toString(),
      );
      await expectLater(
        store.writeChunk(manifest, chunk, bytes),
        throwsA(isA<CompanionProtocolException>()),
      );
      await Link(chunkPath).delete();
      if (Platform.isMacOS || Platform.isLinux) {
        final linkResult = await Process.run('/bin/ln', <String>[
          external.path,
          chunkPath,
        ]);
        expect(linkResult.exitCode, 0);
        await expectLater(
          store.writeChunk(manifest, chunk, bytes),
          throwsA(isA<CompanionProtocolException>()),
        );
      }
      expect(await external.readAsBytes(), bytes);
    });

    test('never overwrites a conflicting completed transfer', () async {
      final bytes = utf8.encode('payload');
      final manifest = _manifest(bytes, chunkBytes: 4096);
      final store = FileCompanionTransferStore(root: temporary);
      await store.begin(manifest);
      final chunk = CompanionChunk(
        transferId: manifest.transferId,
        index: 0,
        offset: 0,
        plaintextBytes: bytes.length,
        sha256: sha256.convert(bytes).toString(),
      );
      await store.writeChunk(manifest, chunk, bytes);
      final transferDirectory = Directory(
        '${temporary.path}/${sha256.convert(utf8.encode(manifest.idempotencyKey))}',
      );
      final staged = File('${transferDirectory.path}/complete.media');
      await staged.writeAsBytes(utf8.encode('hostile'), flush: true);

      await expectLater(
        store.verifyAndStage(manifest),
        throwsA(isA<CompanionProtocolException>()),
      );
      expect(await staged.readAsString(), 'hostile');
    });

    test('real loopback socket resumes missing encrypted chunks', () async {
      final bytes = List<int>.generate(9000, (index) => index % 251);
      final source = File('${temporary.path}/source.wav');
      await source.writeAsBytes(bytes, flush: true);
      final manifest = CompanionTransferManifest(
        transferId: 'transfer-network-1',
        sourceAssetId: 'mobile-recording-network-1',
        displayName: 'network.wav',
        sizeBytes: bytes.length,
        wholeFileSha256: sha256.convert(bytes).toString(),
        chunkBytes: 4096,
        chunkCount: 3,
        createdAtMs: 1,
      );
      final credential = List<int>.generate(32, (index) => index + 1);
      final mobileFingerprint = 'M'.padRight(32, 'M');
      final desktopFingerprint = 'D'.padRight(32, 'D');
      var commitCount = 0;
      var pairingConfirmations = 0;
      CompanionPeerTrust? pairedTrust;
      final receiver = CompanionTransferReceiver(
        store: FileCompanionTransferStore(
          root: Directory('${temporary.path}/receiver'),
        ),
        desktopDeviceId: 'desktop-network-1',
        desktopDeviceName: 'Studio Mac',
        signReceipt: (_) async => base64Encode(List<int>.filled(64, 3)),
        commitImport: (path, _) async {
          commitCount++;
          return (
            recordingId: 88,
            committedSha256: await sha256
                .bind(File(path).openRead())
                .first
                .then((value) => value.toString()),
          );
        },
      );
      final server = CompanionSocketServer(
        identity: CompanionServerIdentity(
          deviceId: 'desktop-network-1',
          deviceName: 'Studio Mac',
          fingerprint: desktopFingerprint,
        ),
        address: InternetAddress.loopbackIPv4,
        lookupPeer: (deviceId) async =>
            deviceId == 'mobile-network-1' ? pairedTrust : null,
        resolveInvitedPeer:
            ({
              required pairingId,
              required deviceId,
              required deviceName,
              required fingerprint,
            }) async {
              if (pairingId != 'pairing-network-1') return null;
              return CompanionPeerTrust(
                peerDeviceId: deviceId,
                peerFingerprint: fingerprint,
                sharedCredential: credential,
                pairedAtMs: 1,
              );
            },
        confirmInvitedPeer:
            ({
              required pairingId,
              required deviceId,
              required deviceName,
              required fingerprint,
              required trust,
            }) async {
              pairingConfirmations++;
              pairedTrust = trust;
            },
        receiver: receiver,
      );
      final port = await server.start();
      final client = CompanionSocketClient(
        deviceId: 'mobile-network-1',
        deviceName: 'Test Phone',
        deviceFingerprint: mobileFingerprint,
        targetDeviceId: 'desktop-network-1',
        targetFingerprint: desktopFingerprint,
        sharedCredential: credential,
        pairingId: 'pairing-network-1',
      );
      try {
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
        var resumedBytes = 0;
        final receipt = await client.sendFile(
          address: InternetAddress.loopbackIPv4,
          port: port,
          source: source,
          manifest: manifest,
          onProgress: (sent, _) => resumedBytes = sent,
        );
        expect(resumedBytes, bytes.length - 4096);
        expect(receipt.desktopRecordingId, 88);
        final duplicate = await client.sendFile(
          address: InternetAddress.loopbackIPv4,
          port: port,
          source: source,
          manifest: manifest,
        );
        expect(duplicate.receiptId, receipt.receiptId);
        expect(commitCount, 1);
        expect(pairingConfirmations, 1);
      } finally {
        await server.stop();
      }
    });
  });
}

CompanionTransferManifest _manifest(
  List<int> bytes, {
  required int chunkBytes,
}) {
  return CompanionTransferManifest(
    transferId: 'transfer-1',
    sourceAssetId: 'mobile-recording-1',
    displayName: 'meeting.wav',
    sizeBytes: bytes.length,
    wholeFileSha256: sha256.convert(bytes).toString(),
    chunkBytes: chunkBytes,
    chunkCount: 1,
    createdAtMs: 1,
  );
}
