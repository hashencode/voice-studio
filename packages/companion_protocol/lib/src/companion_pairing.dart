import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'companion_models.dart';

class CompanionPairingTranscript {
  CompanionPairingTranscript({
    required this.pairingId,
    required this.initiatorDeviceId,
    required this.initiatorFingerprint,
    required this.initiatorEphemeralPublicKey,
    required this.responderDeviceId,
    required this.responderFingerprint,
    required this.responderEphemeralPublicKey,
    required this.shortCodeHash,
    required this.expiresAtMs,
    required List<String> capabilities,
  }) : capabilities = List<String>.unmodifiable(capabilities) {
    if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$').hasMatch(pairingId) ||
        initiatorDeviceId.isEmpty ||
        responderDeviceId.isEmpty ||
        !RegExp(r'^[A-Z2-7]{20,64}$').hasMatch(initiatorFingerprint) ||
        !RegExp(r'^[A-Z2-7]{20,64}$').hasMatch(responderFingerprint) ||
        !_isCanonicalFixedBase64(initiatorEphemeralPublicKey, 32) ||
        !_isCanonicalFixedBase64(responderEphemeralPublicKey, 32) ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(shortCodeHash) ||
        expiresAtMs < 0 ||
        capabilities.length != 1 ||
        capabilities.first != companionMediaTransferCapability) {
      throw const CompanionProtocolException(
        'INVALID_PAIRING_TRANSCRIPT',
        'Pairing transcript is invalid.',
      );
    }
  }

  final String pairingId;
  final String initiatorDeviceId;
  final String initiatorFingerprint;
  final String initiatorEphemeralPublicKey;
  final String responderDeviceId;
  final String responderFingerprint;
  final String responderEphemeralPublicKey;
  final String shortCodeHash;
  final int expiresAtMs;
  final List<String> capabilities;

  Map<String, Object> toJson() => <String, Object>{
    'schema': companionMediaTransferSchema,
    'pairingId': pairingId,
    'initiatorDeviceId': initiatorDeviceId,
    'initiatorFingerprint': initiatorFingerprint,
    'initiatorEphemeralPublicKey': initiatorEphemeralPublicKey,
    'responderDeviceId': responderDeviceId,
    'responderFingerprint': responderFingerprint,
    'responderEphemeralPublicKey': responderEphemeralPublicKey,
    'shortCodeHash': shortCodeHash,
    'expiresAtMs': expiresAtMs,
    'capabilities': capabilities,
  };

  List<int> canonicalBytes() => utf8.encode(jsonEncode(toJson()));

  static String hashShortCode({
    required String pairingId,
    required String code,
  }) {
    if (!RegExp(r'^[0-9]{6}$').hasMatch(code)) {
      throw const CompanionProtocolException(
        'INVALID_SHORT_CODE',
        'Pairing short code must contain six digits.',
      );
    }
    return sha256.convert(utf8.encode('$pairingId:$code')).toString();
  }
}

bool _isCanonicalFixedBase64(String value, int expectedBytes) {
  try {
    final bytes = base64Decode(value);
    return bytes.length == expectedBytes && base64Encode(bytes) == value;
  } on FormatException {
    return false;
  }
}

class CompanionPairingGuard {
  CompanionPairingGuard({required this.expiresAtMs, this.maximumAttempts = 5}) {
    if (maximumAttempts < 1 || maximumAttempts > 10) {
      throw ArgumentError.value(maximumAttempts, 'maximumAttempts');
    }
  }

  final int expiresAtMs;
  final int maximumAttempts;
  int _attempts = 0;
  bool _consumed = false;

  int get attempts => _attempts;

  void verify({
    required int nowMs,
    required String expectedHash,
    required String pairingId,
    required String code,
  }) {
    if (_consumed) {
      throw const CompanionProtocolException(
        'PAIRING_ALREADY_USED',
        'Pairing challenge has already been consumed.',
      );
    }
    if (nowMs > expiresAtMs) {
      throw const CompanionProtocolException(
        'PAIRING_EXPIRED',
        'Pairing challenge has expired.',
      );
    }
    if (_attempts >= maximumAttempts) {
      throw const CompanionProtocolException(
        'PAIRING_LOCKED',
        'Pairing attempt limit has been reached.',
      );
    }
    _attempts++;
    final actual = CompanionPairingTranscript.hashShortCode(
      pairingId: pairingId,
      code: code,
    );
    if (!_constantTimeEquals(actual.codeUnits, expectedHash.codeUnits)) {
      throw const CompanionProtocolException(
        'PAIRING_CODE_MISMATCH',
        'Pairing short code does not match.',
      );
    }
    _consumed = true;
  }
}

class CompanionPeerTrust {
  CompanionPeerTrust({
    required this.peerDeviceId,
    required this.peerFingerprint,
    required this.sharedCredential,
    required this.pairedAtMs,
    this.revokedAtMs,
  }) {
    if (peerDeviceId.isEmpty ||
        !RegExp(r'^[A-Z2-7]{20,64}$').hasMatch(peerFingerprint) ||
        sharedCredential.length != 32 ||
        pairedAtMs < 0) {
      throw const CompanionProtocolException(
        'INVALID_PEER_TRUST',
        'Peer trust record is invalid.',
      );
    }
  }

  final String peerDeviceId;
  final String peerFingerprint;
  final List<int> sharedCredential;
  final int pairedAtMs;
  final int? revokedAtMs;

  bool get revoked => revokedAtMs != null;

  void requireUsable({
    required String presentedFingerprint,
    required bool restoredFromBackup,
  }) {
    if (revoked) {
      throw const CompanionProtocolException(
        'PEER_REVOKED',
        'Peer trust has been revoked.',
      );
    }
    if (restoredFromBackup) {
      throw const CompanionProtocolException(
        'BACKUP_RESTORE_REPAIR_REQUIRED',
        'Restored trust material must be paired again.',
      );
    }
    if (presentedFingerprint != peerFingerprint) {
      throw const CompanionProtocolException(
        'PEER_KEY_CHANGED',
        'Peer identity key changed; pairing is required.',
      );
    }
  }
}

bool _constantTimeEquals(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference == 0;
}
