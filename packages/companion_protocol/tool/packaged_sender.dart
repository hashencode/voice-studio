import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';

Future<void> main(List<String> arguments) async {
  if (arguments.firstOrNull == 'pair-checkpoint') {
    await _pairAndCheckpoint(arguments);
    return;
  }
  if (arguments.length != 10) {
    stderr.writeln('packaged companion sender arguments are invalid');
    exitCode = 64;
    return;
  }
  final mode = arguments[0];
  final port = int.tryParse(arguments[1]);
  final source = File(arguments[2]);
  final transferId = arguments[3];
  final expectedSourceSha256 = arguments[4];
  final targetDeviceId = arguments[5];
  final targetFingerprint = arguments[6];
  final targetPublicKey = base64Decode(arguments[7]);
  final deviceFingerprint = arguments[8];
  final manifestCreatedAtMs = int.tryParse(arguments[9]);
  final credential = await stdin.fold<List<int>>(<int>[], (bytes, chunk) {
    if (bytes.length + chunk.length > 32) return <int>[...bytes, ...chunk, 0];
    return <int>[...bytes, ...chunk];
  });
  try {
    if (port == null ||
        port < 1 ||
        port > 65535 ||
        credential.length != 32 ||
        (mode != 'checkpoint' && mode != 'resume') ||
        targetPublicKey.length != 32 ||
        !RegExp(r'^[A-Z2-7]{20,64}$').hasMatch(deviceFingerprint) ||
        manifestCreatedAtMs == null ||
        manifestCreatedAtMs < 1 ||
        !await source.exists() ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedSourceSha256)) {
      throw const CompanionProtocolException(
        'INVALID_PACKAGED_SENDER_INPUT',
        'Packaged sender input is invalid.',
      );
    }
    final sourceBytes = await source.readAsBytes();
    final sourceSha256 = sha256.convert(sourceBytes).toString();
    if (sourceSha256 != expectedSourceSha256) {
      throw const CompanionProtocolException(
        'SOURCE_HASH_MISMATCH',
        'Packaged sender source hash changed.',
      );
    }
    const chunkBytes = 4096;
    final manifest = CompanionTransferManifest(
      transferId: transferId,
      sourceAssetId: 'asset-packaged-companion-1',
      displayName: 'companion-source.wav',
      sizeBytes: sourceBytes.length,
      wholeFileSha256: sourceSha256,
      chunkBytes: chunkBytes,
      chunkCount: (sourceBytes.length + chunkBytes - 1) ~/ chunkBytes,
      createdAtMs: manifestCreatedAtMs,
    );
    final client = CompanionSocketClient(
      deviceId: 'mobile-interop-1',
      deviceName: 'Dart Interop Phone',
      deviceFingerprint: deviceFingerprint,
      targetDeviceId: targetDeviceId,
      targetFingerprint: targetFingerprint,
      targetIdentityPublicKey: SimplePublicKey(
        targetPublicKey,
        type: KeyPairType.ed25519,
      ),
      sharedCredential: credential,
    );
    if (mode == 'checkpoint') {
      try {
        await client.sendFile(
          address: InternetAddress.loopbackIPv4,
          port: port,
          source: source,
          manifest: manifest,
          maximumChunksThisConnection: 1,
        );
      } on CompanionProtocolException catch (error) {
        if (error.code != 'SIMULATED_CONNECTION_LOSS') rethrow;
        stdout.write(
          jsonEncode(<String, Object>{
            'schemaVersion': 1,
            'checkpointed': true,
            'sourceSha256': sourceSha256,
          }),
        );
        return;
      }
      throw const CompanionProtocolException(
        'CHECKPOINT_NOT_INTERRUPTED',
        'Checkpoint sender did not stop after its bounded first chunk.',
      );
    }
    final progress = <int>[];
    final receipt = await client.sendFile(
      address: InternetAddress.loopbackIPv4,
      port: port,
      source: source,
      manifest: manifest,
      onProgress: (sent, _) => progress.add(sent),
    );
    final signature = base64Decode(receipt.signature);
    final signatureValid =
        signature.length == 64 &&
        await Ed25519().verify(
          utf8.encode(jsonEncode(receipt.unsignedJson())),
          signature: Signature(
            signature,
            publicKey: SimplePublicKey(
              targetPublicKey,
              type: KeyPairType.ed25519,
            ),
          ),
        );
    final fingerprintValid =
        companionFingerprint(targetPublicKey) == targetFingerprint;
    if (!signatureValid || !fingerprintValid) {
      throw const CompanionProtocolException(
        'RECEIPT_SIGNATURE_INVALID',
        'Desktop receipt signature is invalid.',
      );
    }
    stdout.write(
      jsonEncode(<String, Object>{
        'schemaVersion': 1,
        'transferIdSha256': sha256.convert(utf8.encode(transferId)).toString(),
        'sourceSha256': sourceSha256,
        'resumed': progress.isNotEmpty && progress.first < sourceBytes.length,
        'sentBytesAfterRestart': progress.isEmpty ? 0 : progress.last,
        'senderMayDeleteSource':
            receipt.wholeFileSha256 == sourceSha256 && signatureValid,
        'recordingId': receipt.desktopRecordingId,
        'receiptSignatureSha256': sha256
            .convert(base64Decode(receipt.signature))
            .toString(),
      }),
    );
  } finally {
    credential.fillRange(0, credential.length, 0);
  }
}

Future<void> _pairAndCheckpoint(List<String> arguments) async {
  if (arguments.length != 13) {
    stderr.writeln('packaged pairing sender arguments are invalid');
    exitCode = 64;
    return;
  }
  final port = int.tryParse(arguments[1]);
  final source = File(arguments[2]);
  final transferId = arguments[3];
  final expectedSourceSha256 = arguments[4];
  final targetDeviceId = arguments[5];
  final targetFingerprint = arguments[6];
  final targetIdentityPublicKey = _canonicalPublicKey(arguments[7]);
  final pairingId = arguments[8];
  final shortCode = arguments[9];
  final targetEphemeralPublicKey = _canonicalPublicKey(arguments[10]);
  final expiresAtMs = int.tryParse(arguments[11]);
  final credentialFd = int.tryParse(arguments[12]);
  final identitySeed = await _readFixedPrivateStdin();
  CompanionPeerTrust? pendingTrust;
  try {
    if (port == null ||
        port < 1 ||
        port > 65535 ||
        expiresAtMs == null ||
        credentialFd == null ||
        credentialFd < 3 ||
        credentialFd > 255 ||
        targetIdentityPublicKey == null ||
        targetEphemeralPublicKey == null ||
        !RegExp(r'^\d{6}$').hasMatch(shortCode) ||
        !RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$').hasMatch(pairingId) ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedSourceSha256) ||
        !await source.exists()) {
      throw const CompanionProtocolException(
        'INVALID_PACKAGED_PAIRING_INPUT',
        'Packaged pairing input is invalid.',
      );
    }
    final identity = await CompanionIdentity.fromSeed(identitySeed);
    final sourceBytes = await source.readAsBytes();
    final sourceSha256 = sha256.convert(sourceBytes).toString();
    if (sourceSha256 != expectedSourceSha256 || sourceBytes.length <= 4096) {
      throw const CompanionProtocolException(
        'SOURCE_HASH_MISMATCH',
        'Pairing checkpoint source is invalid.',
      );
    }
    final pairer = CompanionSocketPairingClient(
      deviceId: 'mobile-interop-1',
      deviceName: 'Dart Interop Phone',
      identity: identity,
      pairingId: pairingId,
      shortCode: shortCode,
      targetDeviceId: targetDeviceId,
      targetFingerprint: targetFingerprint,
      targetIdentityPublicKey: SimplePublicKey(
        targetIdentityPublicKey,
        type: KeyPairType.ed25519,
      ),
      targetEphemeralPublicKey: SimplePublicKey(
        targetEphemeralPublicKey,
        type: KeyPairType.x25519,
      ),
      expiresAtMs: expiresAtMs,
      persistPendingTrust: (trust) async {
        final capability = await File(
          '/dev/fd/$credentialFd',
        ).open(mode: FileMode.writeOnly);
        try {
          await capability.writeFrom(trust.sharedCredential);
          await capability.flush();
        } finally {
          await capability.close();
        }
        pendingTrust = trust;
      },
    );
    try {
      await pairer.pair(address: InternetAddress.loopbackIPv4, port: port);
    } on CompanionProtocolException catch (error) {
      if (error.code != 'PAIRING_CONFIRMATION_UNKNOWN') rethrow;
    }
    final trust = pendingTrust;
    if (trust == null) {
      throw const CompanionProtocolException(
        'PAIRING_PENDING_CREDENTIAL_MISSING',
        'Pairing did not produce a pending credential.',
      );
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
    const chunkBytes = 4096;
    final manifest = CompanionTransferManifest(
      transferId: transferId,
      sourceAssetId: 'asset-packaged-companion-1',
      displayName: 'companion-source.wav',
      sizeBytes: sourceBytes.length,
      wholeFileSha256: sourceSha256,
      chunkBytes: chunkBytes,
      chunkCount: (sourceBytes.length + chunkBytes - 1) ~/ chunkBytes,
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    final client = CompanionSocketClient(
      deviceId: 'mobile-interop-1',
      deviceName: 'Dart Interop Phone',
      deviceFingerprint: identity.fingerprint,
      targetDeviceId: targetDeviceId,
      targetFingerprint: targetFingerprint,
      targetIdentityPublicKey: pairer.targetIdentityPublicKey,
      sharedCredential: trust.sharedCredential,
    );
    try {
      await client.sendFile(
        address: InternetAddress.loopbackIPv4,
        port: port,
        source: source,
        manifest: manifest,
        maximumChunksThisConnection: 1,
      );
      throw const CompanionProtocolException(
        'CHECKPOINT_NOT_INTERRUPTED',
        'Pairing checkpoint sender did not stop after its first chunk.',
      );
    } on CompanionProtocolException catch (error) {
      if (error.code != 'SIMULATED_CONNECTION_LOSS') rethrow;
    }
    stdout.write(
      jsonEncode(<String, Object>{
        'schemaVersion': 1,
        'paired': true,
        'checkpointed': true,
        'sourceSha256': sourceSha256,
        'targetFingerprint': targetFingerprint,
        'mobileFingerprint': identity.fingerprint,
        'manifestCreatedAtMs': manifest.createdAtMs,
      }),
    );
  } finally {
    identitySeed.fillRange(0, identitySeed.length, 0);
  }
}

List<int>? _canonicalPublicKey(String encoded) {
  try {
    final bytes = base64Decode(encoded);
    return bytes.length == 32 && base64Encode(bytes) == encoded ? bytes : null;
  } on FormatException {
    return null;
  }
}

Future<List<int>> _readFixedPrivateStdin() async {
  final bytes = await stdin.fold<List<int>>(<int>[], (value, chunk) {
    if (value.length + chunk.length > 32) return <int>[...value, ...chunk, 0];
    return <int>[...value, ...chunk];
  });
  if (bytes.length != 32) {
    bytes.fillRange(0, bytes.length, 0);
    throw const CompanionProtocolException(
      'INVALID_PRIVATE_STDIN',
      'Private stdin must contain exactly 32 bytes.',
    );
  }
  return bytes;
}
