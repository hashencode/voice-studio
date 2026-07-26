import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hashes;
import 'package:cryptography/cryptography.dart';

import 'companion_models.dart';
import 'companion_pairing.dart';

class CompanionIdentity {
  CompanionIdentity._({
    required this.privateSeed,
    required this.publicKey,
    required this.fingerprint,
  });

  final List<int> privateSeed;
  final SimplePublicKey publicKey;
  final String fingerprint;

  static Future<CompanionIdentity> generate() async {
    final algorithm = Ed25519();
    final pair = await algorithm.newKeyPair();
    final seed = await pair.extractPrivateKeyBytes();
    final publicKey = await pair.extractPublicKey();
    return CompanionIdentity._(
      privateSeed: List<int>.unmodifiable(seed),
      publicKey: publicKey,
      fingerprint: companionFingerprint(publicKey.bytes),
    );
  }

  static Future<CompanionIdentity> fromSeed(List<int> seed) async {
    if (seed.length != 32) {
      throw const CompanionProtocolException(
        'INVALID_IDENTITY_SEED',
        'Identity seed must be 32 bytes.',
      );
    }
    final pair = await Ed25519().newKeyPairFromSeed(seed);
    final publicKey = await pair.extractPublicKey();
    return CompanionIdentity._(
      privateSeed: List<int>.unmodifiable(seed),
      publicKey: publicKey,
      fingerprint: companionFingerprint(publicKey.bytes),
    );
  }

  Future<Signature> sign(List<int> bytes) async {
    final pair = await Ed25519().newKeyPairFromSeed(privateSeed);
    return Ed25519().sign(bytes, keyPair: pair);
  }
}

class CompanionSignedPairing {
  const CompanionSignedPairing({
    required this.transcript,
    required this.initiatorPublicKey,
    required this.initiatorSignature,
    required this.responderPublicKey,
    required this.responderSignature,
  });

  final CompanionPairingTranscript transcript;
  final SimplePublicKey initiatorPublicKey;
  final Signature initiatorSignature;
  final SimplePublicKey responderPublicKey;
  final Signature responderSignature;

  Future<void> verify() async {
    if (companionFingerprint(initiatorPublicKey.bytes) !=
            transcript.initiatorFingerprint ||
        companionFingerprint(responderPublicKey.bytes) !=
            transcript.responderFingerprint) {
      throw const CompanionProtocolException(
        'PAIRING_FINGERPRINT_MISMATCH',
        'Pairing identity fingerprint does not match the transcript.',
      );
    }
    final bytes = transcript.canonicalBytes();
    final validInitiator = await Ed25519().verify(
      bytes,
      signature: initiatorSignature,
    );
    final validResponder = await Ed25519().verify(
      bytes,
      signature: responderSignature,
    );
    if (!validInitiator || !validResponder) {
      throw const CompanionProtocolException(
        'PAIRING_SIGNATURE_INVALID',
        'Pairing identity signature is invalid.',
      );
    }
  }
}

class CompanionSession {
  CompanionSession._({
    required this.sessionId,
    required SecretKey sendKey,
    required SecretKey receiveKey,
    required int sendDirection,
    required int receiveDirection,
    required int expiresAtMs,
  }) : _sendKey = sendKey,
       _receiveKey = receiveKey,
       _sendDirection = sendDirection,
       _receiveDirection = receiveDirection,
       _expiresAtMs = expiresAtMs;

  final String sessionId;
  final SecretKey _sendKey;
  final SecretKey _receiveKey;
  final int _sendDirection;
  final int _receiveDirection;
  final int _expiresAtMs;
  int _sendCounter = 0;
  int _highestReceiveCounter = -1;

  static Future<(CompanionSession, CompanionSession)> establish({
    required String sessionId,
    required List<int> sharedCredential,
    required List<int> initiatorNonce,
    required List<int> responderNonce,
    required int expiresAtMs,
  }) async {
    if (sharedCredential.length != 32 ||
        initiatorNonce.length != 32 ||
        responderNonce.length != 32 ||
        expiresAtMs < 0) {
      throw const CompanionProtocolException(
        'INVALID_SESSION_HANDSHAKE',
        'Session handshake material is invalid.',
      );
    }
    final salt = hashes.sha256.convert(<int>[
      ...initiatorNonce,
      ...responderNonce,
    ]).bytes;
    final keyMaterial = await Hkdf(hmac: Hmac.sha256(), outputLength: 64)
        .deriveKey(
          secretKey: SecretKey(sharedCredential),
          nonce: salt,
          info: utf8.encode('$companionMediaTransferSchema:$sessionId'),
        );
    final bytes = await keyMaterial.extractBytes();
    final initiatorSend = SecretKey(bytes.sublist(0, 32));
    final responderSend = SecretKey(bytes.sublist(32, 64));
    return (
      CompanionSession._(
        sessionId: sessionId,
        sendKey: initiatorSend,
        receiveKey: responderSend,
        sendDirection: 0x49325231,
        receiveDirection: 0x52324931,
        expiresAtMs: expiresAtMs,
      ),
      CompanionSession._(
        sessionId: sessionId,
        sendKey: responderSend,
        receiveKey: initiatorSend,
        sendDirection: 0x52324931,
        receiveDirection: 0x49325231,
        expiresAtMs: expiresAtMs,
      ),
    );
  }

  Future<String> seal({
    required CompanionMessageType type,
    required String messageId,
    required Map<String, Object?> payload,
    required int nowMs,
  }) async {
    _requireLive(nowMs);
    final envelope = CompanionEnvelope(
      type: type,
      messageId: messageId,
      sessionId: sessionId,
      counter: _sendCounter++,
      payload: payload,
    );
    final cleartext = utf8.encode(envelope.encode());
    final nonce = _nonce(envelope.counter, direction: _sendDirection);
    final aad = utf8.encode('$companionMediaTransferSchema:$sessionId');
    final box = await AesGcm.with256bits().encrypt(
      cleartext,
      secretKey: _sendKey,
      nonce: nonce,
      aad: aad,
    );
    return jsonEncode(<String, Object>{
      'schema': companionMediaTransferSchema,
      'sessionId': sessionId,
      'counter': envelope.counter,
      'ciphertext': base64Encode(box.cipherText),
      'mac': base64Encode(box.mac.bytes),
    });
  }

  Future<CompanionEnvelope> open({
    required String sealed,
    required int nowMs,
  }) async {
    _requireLive(nowMs);
    if (utf8.encode(sealed).length > companionMaximumMetadataBytes * 2) {
      throw const CompanionProtocolException(
        'SEALED_MESSAGE_TOO_LARGE',
        'Encrypted envelope exceeds the limit.',
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(sealed);
    } on FormatException {
      throw const CompanionProtocolException(
        'INVALID_SEALED_MESSAGE',
        'Encrypted envelope is malformed.',
      );
    }
    if (decoded is! Map) {
      throw const CompanionProtocolException(
        'INVALID_SEALED_MESSAGE',
        'Encrypted envelope is malformed.',
      );
    }
    final map = decoded.cast<String, Object?>();
    if (map.keys.toSet().difference(<String>{
          'schema',
          'sessionId',
          'counter',
          'ciphertext',
          'mac',
        }).isNotEmpty ||
        map.length != 5 ||
        map['schema'] != companionMediaTransferSchema ||
        map['sessionId'] != sessionId ||
        map['counter'] is! int ||
        map['ciphertext'] is! String ||
        map['mac'] is! String) {
      throw const CompanionProtocolException(
        'INVALID_SEALED_MESSAGE',
        'Encrypted envelope fields are invalid.',
      );
    }
    final counter = map['counter']! as int;
    if (counter <= _highestReceiveCounter) {
      throw const CompanionProtocolException(
        'REPLAY_REJECTED',
        'Message counter was already received.',
      );
    }
    final List<int> ciphertext;
    final List<int> mac;
    try {
      ciphertext = base64Decode(map['ciphertext']! as String);
      mac = base64Decode(map['mac']! as String);
    } on FormatException {
      throw const CompanionProtocolException(
        'INVALID_SEALED_MESSAGE',
        'Encrypted envelope payload is malformed.',
      );
    }
    final aad = utf8.encode('$companionMediaTransferSchema:$sessionId');
    final List<int> cleartext;
    try {
      cleartext = await AesGcm.with256bits().decrypt(
        SecretBox(
          ciphertext,
          nonce: _nonce(counter, direction: _receiveDirection),
          mac: Mac(mac),
        ),
        secretKey: _receiveKey,
        aad: aad,
      );
    } on SecretBoxAuthenticationError {
      throw const CompanionProtocolException(
        'AUTHENTICATION_FAILED',
        'Encrypted envelope authentication failed.',
      );
    }
    final envelope = CompanionEnvelope.decode(utf8.decode(cleartext));
    if (envelope.counter != counter || envelope.sessionId != sessionId) {
      throw const CompanionProtocolException(
        'COUNTER_MISMATCH',
        'Encrypted envelope counter does not match.',
      );
    }
    _highestReceiveCounter = counter;
    return envelope;
  }

  Future<Uint8List> sealBytes({
    required List<int> plaintext,
    required int nowMs,
  }) async {
    _requireLive(nowMs);
    if (plaintext.isEmpty || plaintext.length > companionMaximumChunkBytes) {
      throw const CompanionProtocolException(
        'INVALID_BINARY_PAYLOAD',
        'Binary payload is outside the chunk limit.',
      );
    }
    final counter = _sendCounter++;
    final aad = utf8.encode(
      '$companionMediaTransferSchema:$sessionId:binary:$counter',
    );
    final box = await AesGcm.with256bits().encrypt(
      plaintext,
      secretKey: _sendKey,
      nonce: _nonce(counter, direction: _sendDirection),
      aad: aad,
    );
    final header = ByteData(25);
    header.setUint8(0, 1);
    header.setUint64(1, counter, Endian.big);
    final output = BytesBuilder(copy: false)
      ..add(header.buffer.asUint8List(0, 9))
      ..add(box.mac.bytes)
      ..add(box.cipherText);
    return output.takeBytes();
  }

  Future<Uint8List> openBytes({
    required List<int> packet,
    required int nowMs,
  }) async {
    _requireLive(nowMs);
    if (packet.length < 26 ||
        packet.length > companionMaximumChunkBytes + 25 ||
        packet.first != 1) {
      throw const CompanionProtocolException(
        'INVALID_BINARY_PACKET',
        'Encrypted binary packet is malformed.',
      );
    }
    final header = ByteData.sublistView(Uint8List.fromList(packet), 0, 9);
    final counter = header.getUint64(1, Endian.big);
    if (counter <= _highestReceiveCounter) {
      throw const CompanionProtocolException(
        'REPLAY_REJECTED',
        'Binary packet counter was already received.',
      );
    }
    final aad = utf8.encode(
      '$companionMediaTransferSchema:$sessionId:binary:$counter',
    );
    final List<int> cleartext;
    try {
      cleartext = await AesGcm.with256bits().decrypt(
        SecretBox(
          packet.sublist(25),
          nonce: _nonce(counter, direction: _receiveDirection),
          mac: Mac(packet.sublist(9, 25)),
        ),
        secretKey: _receiveKey,
        aad: aad,
      );
    } on SecretBoxAuthenticationError {
      throw const CompanionProtocolException(
        'AUTHENTICATION_FAILED',
        'Encrypted binary authentication failed.',
      );
    }
    _highestReceiveCounter = counter;
    return Uint8List.fromList(cleartext);
  }

  void _requireLive(int nowMs) {
    if (nowMs > _expiresAtMs) {
      throw const CompanionProtocolException(
        'SESSION_EXPIRED',
        'Encrypted session has expired.',
      );
    }
  }

  Uint8List _nonce(int counter, {required int direction}) {
    if (counter < 0 || counter > 0x7fffffffffffffff) {
      throw const CompanionProtocolException(
        'INVALID_COUNTER',
        'Session counter is invalid.',
      );
    }
    final bytes = ByteData(12);
    bytes.setUint32(0, direction, Endian.big);
    bytes.setUint64(4, counter, Endian.big);
    return bytes.buffer.asUint8List();
  }
}

String companionFingerprint(List<int> publicKeyBytes) {
  final digest = hashes.sha256.convert(publicKeyBytes).bytes;
  return _base32(digest.sublist(0, 20));
}

String _base32(List<int> bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  final output = StringBuffer();
  var value = 0;
  var bits = 0;
  for (final byte in bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output.write(alphabet[(value >> (bits - 5)) & 31]);
      bits -= 5;
    }
  }
  if (bits > 0) output.write(alphabet[(value << (5 - bits)) & 31]);
  return output.toString();
}
