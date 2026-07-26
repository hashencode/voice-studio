import 'dart:convert';

const String companionMediaTransferSchema = 'companion-media-transfer/v1';
const String companionMediaTransferCapability = 'media-transfer/v1';
const int companionMaximumMetadataBytes = 64 * 1024;
const int companionMaximumChunkBytes = 1024 * 1024;
const int companionDefaultChunkBytes = 256 * 1024;
const int companionMaximumChunkCount = 65536;
const int companionMaximumSourceBytes = 4 * 1024 * 1024 * 1024;

final RegExp _identifier = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$');
final RegExp _sha256 = RegExp(r'^[a-f0-9]{64}$');
final RegExp _fingerprint = RegExp(r'^[A-Z2-7]{20,64}$');

class CompanionProtocolException implements Exception {
  const CompanionProtocolException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => '$code: $message';
}

enum CompanionMessageType {
  discovery,
  pairingTranscript,
  capability,
  manifest,
  chunk,
  checkpoint,
  receipt,
  cancel,
  error,
}

class CompanionEnvelope {
  CompanionEnvelope({
    required this.type,
    required this.messageId,
    required this.sessionId,
    required this.counter,
    required this.payload,
  }) {
    _requireIdentifier(messageId, 'messageId');
    _requireIdentifier(sessionId, 'sessionId');
    if (counter < 0) {
      throw const CompanionProtocolException(
        'INVALID_COUNTER',
        'Message counter must be non-negative.',
      );
    }
    _requireBoundedJson(payload);
  }

  factory CompanionEnvelope.decode(String encoded) {
    if (utf8.encode(encoded).length > companionMaximumMetadataBytes) {
      throw const CompanionProtocolException(
        'METADATA_TOO_LARGE',
        'Envelope exceeds the metadata limit.',
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(encoded);
    } on FormatException {
      throw const CompanionProtocolException(
        'INVALID_JSON',
        'Envelope is not valid JSON.',
      );
    }
    final map = _stringMap(decoded, 'envelope');
    _requireExactKeys(map, <String>{
      'schema',
      'type',
      'messageId',
      'sessionId',
      'counter',
      'payload',
    });
    if (map['schema'] != companionMediaTransferSchema) {
      throw const CompanionProtocolException(
        'UNSUPPORTED_SCHEMA',
        'Unsupported companion media transfer schema.',
      );
    }
    final typeName = map['type'];
    final type = CompanionMessageType.values
        .where((value) => value.name == typeName)
        .firstOrNull;
    if (type == null) {
      throw const CompanionProtocolException(
        'UNKNOWN_MESSAGE_TYPE',
        'Unknown companion message type.',
      );
    }
    return CompanionEnvelope(
      type: type,
      messageId: _string(map['messageId'], 'messageId'),
      sessionId: _string(map['sessionId'], 'sessionId'),
      counter: _integer(map['counter'], 'counter'),
      payload: _stringMap(map['payload'], 'payload'),
    );
  }

  final CompanionMessageType type;
  final String messageId;
  final String sessionId;
  final int counter;
  final Map<String, Object?> payload;

  String encode() {
    final encoded = jsonEncode(<String, Object?>{
      'schema': companionMediaTransferSchema,
      'type': type.name,
      'messageId': messageId,
      'sessionId': sessionId,
      'counter': counter,
      'payload': payload,
    });
    if (utf8.encode(encoded).length > companionMaximumMetadataBytes) {
      throw const CompanionProtocolException(
        'METADATA_TOO_LARGE',
        'Envelope exceeds the metadata limit.',
      );
    }
    return encoded;
  }
}

class CompanionDiscoveryDescriptor {
  CompanionDiscoveryDescriptor({
    required this.deviceId,
    required this.deviceName,
    required this.port,
    required this.identityFingerprint,
    required this.capabilities,
  }) {
    _requireIdentifier(deviceId, 'deviceId');
    _requireText(deviceName, 'deviceName', 80);
    if (port < 1 || port > 65535) {
      throw const CompanionProtocolException(
        'INVALID_PORT',
        'Discovery port is invalid.',
      );
    }
    _requireFingerprint(identityFingerprint);
    if (capabilities.isEmpty ||
        capabilities.length > 8 ||
        !capabilities.every(_identifier.hasMatch)) {
      throw const CompanionProtocolException(
        'INVALID_CAPABILITY',
        'Discovery capabilities are invalid.',
      );
    }
  }

  final String deviceId;
  final String deviceName;
  final int port;
  final String identityFingerprint;
  final List<String> capabilities;

  Map<String, Object> toJson() => <String, Object>{
    'deviceId': deviceId,
    'deviceName': deviceName,
    'port': port,
    'identityFingerprint': identityFingerprint,
    'capabilities': capabilities,
  };
}

class CompanionCapability {
  CompanionCapability({
    required this.maxChunkBytes,
    required this.maxSourceBytes,
    required this.resume,
    required this.receipts,
  }) {
    if (maxChunkBytes < 4096 ||
        maxChunkBytes > companionMaximumChunkBytes ||
        maxSourceBytes < 1 ||
        maxSourceBytes > companionMaximumSourceBytes) {
      throw const CompanionProtocolException(
        'INVALID_CAPABILITY',
        'Transfer capability is outside the supported envelope.',
      );
    }
  }

  final int maxChunkBytes;
  final int maxSourceBytes;
  final bool resume;
  final bool receipts;

  Map<String, Object> toJson() => <String, Object>{
    'capability': companionMediaTransferCapability,
    'maxChunkBytes': maxChunkBytes,
    'maxSourceBytes': maxSourceBytes,
    'resume': resume,
    'receipts': receipts,
  };
}

class CompanionTransferManifest {
  CompanionTransferManifest({
    required this.transferId,
    required this.sourceAssetId,
    required this.displayName,
    required this.sizeBytes,
    required this.wholeFileSha256,
    required this.chunkBytes,
    required this.chunkCount,
    required this.createdAtMs,
  }) {
    _requireIdentifier(transferId, 'transferId');
    _requireIdentifier(sourceAssetId, 'sourceAssetId');
    _requireText(displayName, 'displayName', 160);
    _requireSha256(wholeFileSha256, 'wholeFileSha256');
    if (sizeBytes < 1 || sizeBytes > companionMaximumSourceBytes) {
      throw const CompanionProtocolException(
        'INVALID_SIZE',
        'Source size is outside the supported envelope.',
      );
    }
    if (chunkBytes < 4096 || chunkBytes > companionMaximumChunkBytes) {
      throw const CompanionProtocolException(
        'INVALID_CHUNK_SIZE',
        'Chunk size is outside the supported envelope.',
      );
    }
    final expected = (sizeBytes + chunkBytes - 1) ~/ chunkBytes;
    if (chunkCount != expected ||
        chunkCount < 1 ||
        chunkCount > companionMaximumChunkCount) {
      throw const CompanionProtocolException(
        'INVALID_CHUNK_COUNT',
        'Chunk count does not match source size.',
      );
    }
    _requireTimestamp(createdAtMs);
  }

  factory CompanionTransferManifest.fromJson(Map<String, Object?> map) {
    _requireExactKeys(map, <String>{
      'schema',
      'transferId',
      'sourceAssetId',
      'displayName',
      'sizeBytes',
      'wholeFileSha256',
      'chunkBytes',
      'chunkCount',
      'createdAtMs',
    });
    if (map['schema'] != companionMediaTransferSchema) {
      throw const CompanionProtocolException(
        'UNSUPPORTED_SCHEMA',
        'Unsupported transfer manifest schema.',
      );
    }
    return CompanionTransferManifest(
      transferId: _string(map['transferId'], 'transferId'),
      sourceAssetId: _string(map['sourceAssetId'], 'sourceAssetId'),
      displayName: _string(map['displayName'], 'displayName'),
      sizeBytes: _integer(map['sizeBytes'], 'sizeBytes'),
      wholeFileSha256: _string(map['wholeFileSha256'], 'wholeFileSha256'),
      chunkBytes: _integer(map['chunkBytes'], 'chunkBytes'),
      chunkCount: _integer(map['chunkCount'], 'chunkCount'),
      createdAtMs: _integer(map['createdAtMs'], 'createdAtMs'),
    );
  }

  final String transferId;
  final String sourceAssetId;
  final String displayName;
  final int sizeBytes;
  final String wholeFileSha256;
  final int chunkBytes;
  final int chunkCount;
  final int createdAtMs;

  String get idempotencyKey => '$transferId:$wholeFileSha256';

  int expectedChunkLength(int index) {
    if (index < 0 || index >= chunkCount) {
      throw const CompanionProtocolException(
        'INVALID_CHUNK_INDEX',
        'Chunk index is outside the manifest.',
      );
    }
    if (index < chunkCount - 1) return chunkBytes;
    return sizeBytes - (chunkBytes * (chunkCount - 1));
  }

  Map<String, Object> toJson() => <String, Object>{
    'schema': companionMediaTransferSchema,
    'transferId': transferId,
    'sourceAssetId': sourceAssetId,
    'displayName': displayName,
    'sizeBytes': sizeBytes,
    'wholeFileSha256': wholeFileSha256,
    'chunkBytes': chunkBytes,
    'chunkCount': chunkCount,
    'createdAtMs': createdAtMs,
  };
}

class CompanionChunk {
  CompanionChunk({
    required this.transferId,
    required this.index,
    required this.offset,
    required this.plaintextBytes,
    required this.sha256,
  }) {
    _requireIdentifier(transferId, 'transferId');
    if (index < 0 ||
        index >= companionMaximumChunkCount ||
        offset < 0 ||
        plaintextBytes < 1 ||
        plaintextBytes > companionMaximumChunkBytes) {
      throw const CompanionProtocolException(
        'INVALID_CHUNK_BOUNDS',
        'Chunk bounds are invalid.',
      );
    }
    _requireSha256(sha256, 'sha256');
  }

  final String transferId;
  final int index;
  final int offset;
  final int plaintextBytes;
  final String sha256;

  Map<String, Object> toJson() => <String, Object>{
    'transferId': transferId,
    'index': index,
    'offset': offset,
    'plaintextBytes': plaintextBytes,
    'sha256': sha256,
  };
}

class CompanionCheckpoint {
  CompanionCheckpoint({
    required this.transferId,
    required this.wholeFileSha256,
    required Iterable<int> missingChunks,
    required this.updatedAtMs,
  }) : missingChunks = List<int>.unmodifiable(missingChunks) {
    _requireIdentifier(transferId, 'transferId');
    _requireSha256(wholeFileSha256, 'wholeFileSha256');
    _requireTimestamp(updatedAtMs);
    if (this.missingChunks.length > companionMaximumChunkCount ||
        this.missingChunks.any(
          (value) => value < 0 || value >= companionMaximumChunkCount,
        ) ||
        this.missingChunks.toSet().length != this.missingChunks.length) {
      throw const CompanionProtocolException(
        'INVALID_CHECKPOINT',
        'Checkpoint missing chunk set is invalid.',
      );
    }
  }

  final String transferId;
  final String wholeFileSha256;
  final List<int> missingChunks;
  final int updatedAtMs;

  Map<String, Object> toJson() => <String, Object>{
    'transferId': transferId,
    'wholeFileSha256': wholeFileSha256,
    'missingChunks': missingChunks,
    'updatedAtMs': updatedAtMs,
  };
}

class CompanionReceipt {
  CompanionReceipt({
    required this.receiptId,
    required this.transferId,
    required this.wholeFileSha256,
    required this.sizeBytes,
    required this.desktopDeviceId,
    required this.desktopDeviceName,
    required this.desktopRecordingId,
    required this.committedAtMs,
    required this.signature,
  }) {
    _requireIdentifier(receiptId, 'receiptId');
    _requireIdentifier(transferId, 'transferId');
    _requireSha256(wholeFileSha256, 'wholeFileSha256');
    _requireIdentifier(desktopDeviceId, 'desktopDeviceId');
    _requireText(desktopDeviceName, 'desktopDeviceName', 80);
    _requireTimestamp(committedAtMs);
    if (sizeBytes < 1 ||
        sizeBytes > companionMaximumSourceBytes ||
        desktopRecordingId < 1 ||
        signature.isEmpty ||
        signature.length > 256) {
      throw const CompanionProtocolException(
        'INVALID_RECEIPT',
        'Receipt fields are invalid.',
      );
    }
  }

  final String receiptId;
  final String transferId;
  final String wholeFileSha256;
  final int sizeBytes;
  final String desktopDeviceId;
  final String desktopDeviceName;
  final int desktopRecordingId;
  final int committedAtMs;
  final String signature;

  Map<String, Object> unsignedJson() => <String, Object>{
    'schema': companionMediaTransferSchema,
    'receiptId': receiptId,
    'transferId': transferId,
    'wholeFileSha256': wholeFileSha256,
    'sizeBytes': sizeBytes,
    'desktopDeviceId': desktopDeviceId,
    'desktopDeviceName': desktopDeviceName,
    'desktopRecordingId': desktopRecordingId,
    'committedAtMs': committedAtMs,
  };

  Map<String, Object> toJson() => <String, Object>{
    ...unsignedJson(),
    'signature': signature,
  };
}

void _requireExactKeys(Map<String, Object?> map, Set<String> expected) {
  if (map.keys.toSet().difference(expected).isNotEmpty ||
      expected.difference(map.keys.toSet()).isNotEmpty) {
    throw const CompanionProtocolException(
      'INVALID_FIELDS',
      'Message contains missing or unknown fields.',
    );
  }
}

void _requireBoundedJson(Map<String, Object?> map) {
  if (utf8.encode(jsonEncode(map)).length > companionMaximumMetadataBytes) {
    throw const CompanionProtocolException(
      'METADATA_TOO_LARGE',
      'Message metadata exceeds the limit.',
    );
  }
}

Map<String, Object?> _stringMap(Object? value, String field) {
  if (value is! Map) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  if (value.keys.any((key) => key is! String)) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  return value.cast<String, Object?>();
}

String _string(Object? value, String field) {
  if (value is! String) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  return value;
}

int _integer(Object? value, String field) {
  if (value is! int) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  return value;
}

void _requireIdentifier(String value, String field) {
  if (!_identifier.hasMatch(value)) {
    throw CompanionProtocolException(
      'INVALID_IDENTIFIER',
      '$field is invalid.',
    );
  }
}

void _requireSha256(String value, String field) {
  if (!_sha256.hasMatch(value)) {
    throw CompanionProtocolException('INVALID_HASH', '$field is invalid.');
  }
}

void _requireFingerprint(String value) {
  if (!_fingerprint.hasMatch(value)) {
    throw const CompanionProtocolException(
      'INVALID_FINGERPRINT',
      'Identity fingerprint is invalid.',
    );
  }
}

void _requireText(String value, String field, int maxRunes) {
  if (value.trim().isEmpty ||
      value.runes.length > maxRunes ||
      value.contains(RegExp(r'[\u0000-\u001f]'))) {
    throw CompanionProtocolException('INVALID_TEXT', '$field is invalid.');
  }
}

void _requireTimestamp(int value) {
  if (value < 0 || value > 9999999999999) {
    throw const CompanionProtocolException(
      'INVALID_TIMESTAMP',
      'Timestamp is invalid.',
    );
  }
}
