import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../../records/model/recording_entity.dart';
import '../../records/repository/recordings_repository.dart';
import '../../records/service/audio_deletion_coordinator.dart';
import '../service/android_companion_platform.dart';

class MobileCompanionPeer {
  const MobileCompanionPeer({
    required this.deviceId,
    required this.displayName,
    required this.fingerprint,
    required this.pairedAtMs,
    this.pendingPairingId,
  });

  final String deviceId;
  final String displayName;
  final String fingerprint;
  final int pairedAtMs;
  final String? pendingPairingId;
}

class MobileCompanionHistory {
  const MobileCompanionHistory({
    required this.transferId,
    required this.recordingId,
    required this.displayName,
    required this.hash,
    required this.sizeBytes,
    required this.state,
    required this.cleanupState,
    required this.createdAtMs,
    this.receipt,
  });

  final String transferId;
  final int recordingId;
  final String displayName;
  final String hash;
  final int sizeBytes;
  final String state;
  final String cleanupState;
  final int createdAtMs;
  final CompanionReceipt? receipt;
}

typedef MobileCompanionPairingRunner =
    Future<CompanionPeerTrust> Function({
      required CompanionSocketPairingClient client,
      required InternetAddress address,
      required int port,
    });

Future<CompanionPeerTrust> _runMobileCompanionPairing({
  required CompanionSocketPairingClient client,
  required InternetAddress address,
  required int port,
}) => client.pair(address: address, port: port);

const _pairingArtifactKeys = <String>{
  'schema',
  'pairingId',
  'targetDeviceId',
  'targetDeviceName',
  'targetFingerprint',
  'targetIdentityPublicKey',
  'targetEphemeralPublicKey',
  'host',
  'port',
  'expiresAtMs',
};
const _pairingMaximumLifetimeMs = 2 * 60 * 1000;
const _pairingExpiryToleranceMs = 5000;

class MobileCompanionRepository {
  MobileCompanionRepository({
    AppDatabase? database,
    RecordingsRepository? recordingsRepository,
    AudioDeletionCoordinator? deletionCoordinator,
    CompanionPlatformPort platform = const AndroidCompanionPlatform(),
    MobileCompanionPairingRunner pairingRunner = _runMobileCompanionPairing,
  }) : _database = database ?? AppDatabase.instance,
       _recordingsRepository =
           recordingsRepository ?? RecordingsRepository(database: database),
       _deletionCoordinator = deletionCoordinator ?? AudioDeletionCoordinator(),
       _platform = platform,
       _pairingRunner = pairingRunner;

  final AppDatabase _database;
  final RecordingsRepository _recordingsRepository;
  final AudioDeletionCoordinator _deletionCoordinator;
  final CompanionPlatformPort _platform;
  final MobileCompanionPairingRunner _pairingRunner;

  Future<CompanionIdentity> identity() async {
    var seed = await _platform.getCredential('identity.seed.v1');
    if (seed == null) {
      final generated = await CompanionIdentity.generate();
      seed = generated.privateSeed;
      await _platform.putCredential('identity.seed.v1', seed);
      return generated;
    }
    return CompanionIdentity.fromSeed(seed);
  }

  Future<MobileCompanionPeer> acceptPairingInvite({
    required String encodedPayload,
    required String confirmedShortCode,
    int? nowMs,
  }) async {
    final Object? decoded;
    try {
      decoded = jsonDecode(encodedPayload);
    } on Object {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation is invalid.',
      );
    }
    if (decoded is! Map || decoded.keys.any((key) => key is! String)) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation is invalid.',
      );
    }
    final map = decoded.cast<String, Object?>();
    if (map.containsKey('sharedCredential') || map.containsKey('shortCode')) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_SECRET_PRESENT',
        'Pairing invitation must contain public material only.',
      );
    }
    if (map['schema'] != companionMediaTransferSchema) {
      throw const CompanionProtocolException(
        'UNSUPPORTED_COMPANION_PROTOCOL',
        'Companion invitation protocol is unsupported.',
      );
    }
    if (map.keys.toSet().difference(_pairingArtifactKeys).isNotEmpty ||
        _pairingArtifactKeys.difference(map.keys.toSet()).isNotEmpty) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation fields are invalid.',
      );
    }
    if (!RegExp(r'^\d{6}$').hasMatch(confirmedShortCode)) {
      throw const CompanionProtocolException(
        'PAIRING_CODE_INVALID',
        'Pairing short code must contain six digits.',
      );
    }
    final acceptedAtMs = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final expiresAtMs = _requiredInteger(map['expiresAtMs'], 'expiry');
    if (expiresAtMs <= acceptedAtMs ||
        expiresAtMs - acceptedAtMs >
            _pairingMaximumLifetimeMs + _pairingExpiryToleranceMs) {
      throw const CompanionProtocolException(
        'PAIRING_EXPIRED',
        'Pairing invitation has expired.',
      );
    }
    final deviceId = _requiredIdentifier(map['targetDeviceId'], 'device');
    final displayName = _requiredDisplayName(map['targetDeviceName']);
    final fingerprint = _requiredFingerprint(map['targetFingerprint']);
    final pairingId = _requiredIdentifier(map['pairingId'], 'pairing');
    final hostValue = map['host'];
    if (hostValue is! String) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation endpoint is invalid.',
      );
    }
    final host = hostValue;
    final address = InternetAddress.tryParse(host);
    final port = _requiredInteger(map['port'], 'port');
    if (address == null || port < 1 || port > 65535) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation endpoint is invalid.',
      );
    }
    final List<int> identityPublicKey;
    final List<int> ephemeralPublicKey;
    try {
      identityPublicKey = _decodeCanonicalKey(map['targetIdentityPublicKey']);
      ephemeralPublicKey = _decodeCanonicalKey(map['targetEphemeralPublicKey']);
    } on CompanionProtocolException {
      rethrow;
    } on Object {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation public keys are invalid.',
      );
    }
    if (companionFingerprint(identityPublicKey) != fingerprint) {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation identity does not match its fingerprint.',
      );
    }
    final localIdentity = await identity();
    var pendingPersisted = false;
    final client = CompanionSocketPairingClient(
      deviceId:
          'mobile-${localIdentity.fingerprint.toLowerCase().substring(0, 20)}',
      deviceName: 'Voice2Text Android',
      identity: localIdentity,
      pairingId: pairingId,
      shortCode: confirmedShortCode,
      targetDeviceId: deviceId,
      targetFingerprint: fingerprint,
      targetIdentityPublicKey: SimplePublicKey(
        identityPublicKey,
        type: KeyPairType.ed25519,
      ),
      targetEphemeralPublicKey: SimplePublicKey(
        ephemeralPublicKey,
        type: KeyPairType.x25519,
      ),
      expiresAtMs: expiresAtMs,
      clockMs: () => nowMs ?? DateTime.now().millisecondsSinceEpoch,
      persistPendingTrust: (trust) async {
        _requireMatchingTrust(trust, deviceId, fingerprint);
        await _persistPendingTrust(
          trust: trust,
          identityPublicKey: identityPublicKey,
          displayName: displayName,
          pairingId: pairingId,
        );
        pendingPersisted = true;
      },
    );
    final trust = await _pairingRunner(
      client: client,
      address: address,
      port: port,
    );
    _requireMatchingTrust(trust, deviceId, fingerprint);
    if (!pendingPersisted) {
      throw const CompanionProtocolException(
        'PAIRING_TRUST_NOT_PERSISTED',
        'Pairing trust was not durably prepared before confirmation.',
      );
    }
    final database = await _database.database;
    final updated = await database.update(
      'companion_peers',
      <String, Object?>{'trust_state': 'active'},
      where: 'device_id = ? AND pending_pairing_id = ? AND trust_state = ?',
      whereArgs: <Object>[deviceId, pairingId, 'repair_required'],
    );
    if (updated != 1) {
      throw const CompanionProtocolException(
        'PAIRING_TRUST_NOT_PERSISTED',
        'Pairing trust could not be activated.',
      );
    }
    return MobileCompanionPeer(
      deviceId: deviceId,
      displayName: displayName,
      fingerprint: fingerprint,
      pairedAtMs: trust.pairedAtMs,
      pendingPairingId: pairingId,
    );
  }

  Future<void> _persistPendingTrust({
    required CompanionPeerTrust trust,
    required List<int> identityPublicKey,
    required String displayName,
    required String pairingId,
  }) async {
    final credentialKey = 'peer.${trust.peerDeviceId}.credential.v1';
    final identityKey = 'peer.${trust.peerDeviceId}.identity-public-key.v1';
    try {
      await _platform.putCredential(credentialKey, trust.sharedCredential);
      await _platform.putCredential(identityKey, identityPublicKey);
      final database = await _database.database;
      await database.insert('companion_peers', <String, Object?>{
        'device_id': trust.peerDeviceId,
        'display_name': displayName,
        'identity_fingerprint': trust.peerFingerprint,
        'pending_pairing_id': pairingId,
        'trust_state': 'repair_required',
        'paired_at_ms': trust.pairedAtMs,
        'last_seen_at_ms': null,
        'revoked_at_ms': null,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    } catch (_) {
      await _deleteCredentialBestEffort(credentialKey);
      await _deleteCredentialBestEffort(identityKey);
      rethrow;
    }
  }

  Future<void> _deleteCredentialBestEffort(String key) async {
    try {
      await _platform.deleteCredential(key);
    } on Object {
      // Preserve the original persistence failure.
    }
  }

  Future<List<MobileCompanionPeer>> listPeers() async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_peers',
      where: 'trust_state = ?',
      whereArgs: <Object>['active'],
      orderBy: 'paired_at_ms DESC',
    );
    return rows
        .map(
          (row) => MobileCompanionPeer(
            deviceId: row['device_id']! as String,
            displayName: row['display_name']! as String,
            fingerprint: row['identity_fingerprint']! as String,
            pairedAtMs: row['paired_at_ms']! as int,
            pendingPairingId: row['pending_pairing_id'] as String?,
          ),
        )
        .toList(growable: false);
  }

  Future<List<RecordingEntity>> listRecordings() =>
      _recordingsRepository.listActive();

  Future<CompanionReceipt> sendRecording({
    required int recordingId,
    required MobileCompanionPeer peer,
    required DiscoveredCompanionDesktop desktop,
    CompanionTransferCancellation? cancellation,
    void Function(int sentBytes, int totalBytes)? onProgress,
  }) async {
    if (desktop.deviceId != peer.deviceId ||
        desktop.fingerprint != peer.fingerprint) {
      throw const CompanionProtocolException(
        'PEER_KEY_CHANGED',
        'Discovered desktop does not match the paired identity.',
      );
    }
    final recording = await _recordingsRepository.findById(recordingId);
    if (recording == null) {
      throw const CompanionProtocolException(
        'SOURCE_MISSING',
        'Mobile audio no longer exists.',
      );
    }
    final source = File(recording.filePath);
    final stat = await source.stat();
    if (stat.type != FileSystemEntityType.file ||
        stat.size < 1 ||
        stat.size > companionMaximumSourceBytes) {
      throw const CompanionProtocolException(
        'SOURCE_INVALID',
        'Mobile source is not a supported regular file.',
      );
    }
    final digest = await sha256.bind(source.openRead()).first;
    final hash = digest.toString();
    final database = await _database.database;
    final sourceAssetId = 'mobile-recording-$recordingId';
    final existing = await database.query(
      'companion_transfers',
      where:
          'source_asset_id = ? AND whole_file_sha256 = ? '
          'AND peer_device_id = ? AND state != ?',
      whereArgs: <Object>[sourceAssetId, hash, peer.deviceId, 'canceled'],
      orderBy: 'created_at_ms DESC',
      limit: 1,
    );
    final transferId = existing.isEmpty
        ? 'transfer-$recordingId-${DateTime.now().millisecondsSinceEpoch}'
        : existing.single['transfer_id']! as String;
    final manifest = CompanionTransferManifest(
      transferId: transferId,
      sourceAssetId: sourceAssetId,
      displayName:
          recording.displayName ??
          recording.sourceDisplayName ??
          source.uri.pathSegments.last,
      sizeBytes: stat.size,
      wholeFileSha256: hash,
      chunkBytes: companionDefaultChunkBytes,
      chunkCount:
          (stat.size + companionDefaultChunkBytes - 1) ~/
          companionDefaultChunkBytes,
      createdAtMs: recording.createdAtMs,
    );
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.insert('companion_transfers', <String, Object?>{
      'transfer_id': transferId,
      'whole_file_sha256': hash,
      'direction': 'send',
      'peer_device_id': peer.deviceId,
      'source_asset_id': sourceAssetId,
      'display_name': manifest.displayName,
      'size_bytes': stat.size,
      'chunk_bytes': manifest.chunkBytes,
      'chunk_count': manifest.chunkCount,
      'state': 'transferring',
      'recording_id': recordingId,
      'receipt_json': null,
      'source_cleanup_state': 'retained',
      'created_at_ms': now,
      'updated_at_ms': now,
      'completed_at_ms': null,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    final credential = await _platform.getCredential(
      'peer.${peer.deviceId}.credential.v1',
    );
    final targetIdentityBytes = await _platform.getCredential(
      'peer.${peer.deviceId}.identity-public-key.v1',
    );
    if (credential == null ||
        targetIdentityBytes == null ||
        targetIdentityBytes.length != 32 ||
        companionFingerprint(targetIdentityBytes) != peer.fingerprint) {
      throw const CompanionProtocolException(
        'PAIRING_REPAIR_REQUIRED',
        'Paired trust material is unavailable.',
      );
    }
    final localIdentity = await identity();
    try {
      final receipt =
          await CompanionSocketClient(
            deviceId:
                'mobile-${localIdentity.fingerprint.toLowerCase().substring(0, 20)}',
            deviceName: 'Voice2Text Android',
            deviceFingerprint: localIdentity.fingerprint,
            targetDeviceId: peer.deviceId,
            targetFingerprint: peer.fingerprint,
            sharedCredential: credential,
            pairingId: peer.pendingPairingId,
            targetIdentityPublicKey: SimplePublicKey(
              targetIdentityBytes,
              type: KeyPairType.ed25519,
            ),
          ).sendFile(
            address: InternetAddress(desktop.host),
            port: desktop.port,
            source: source,
            manifest: manifest,
            cancellation: cancellation,
            onProgress: onProgress,
          );
      if (receipt.wholeFileSha256 != hash ||
          receipt.sizeBytes != stat.size ||
          receipt.desktopDeviceId != peer.deviceId) {
        throw const CompanionProtocolException(
          'RECEIPT_MISMATCH',
          'Desktop receipt does not match the mobile source.',
        );
      }
      await database.transaction((transaction) async {
        await transaction.update(
          'companion_transfers',
          <String, Object?>{
            'state': 'committed',
            'receipt_json': jsonEncode(receipt.toJson()),
            'updated_at_ms': receipt.committedAtMs,
            'completed_at_ms': receipt.committedAtMs,
          },
          where: 'transfer_id = ? AND whole_file_sha256 = ?',
          whereArgs: <Object>[transferId, hash],
        );
        await transaction.update(
          'companion_peers',
          <String, Object?>{
            'pending_pairing_id': null,
            'last_seen_at_ms': receipt.committedAtMs,
          },
          where: 'device_id = ?',
          whereArgs: <Object>[peer.deviceId],
        );
      });
      return receipt;
    } on CompanionProtocolException catch (error) {
      await database.update(
        'companion_transfers',
        <String, Object?>{
          'state': error.code == 'TRANSFER_CANCELED' ? 'canceled' : 'paused',
          'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
        },
        where: 'transfer_id = ? AND whole_file_sha256 = ?',
        whereArgs: <Object>[transferId, hash],
      );
      rethrow;
    }
  }

  Future<List<MobileCompanionHistory>> listHistory() async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_transfers',
      where: 'direction = ?',
      whereArgs: <Object>['send'],
      orderBy: 'created_at_ms DESC',
      limit: 100,
    );
    return rows
        .map((row) {
          final receiptJson = row['receipt_json'] as String?;
          return MobileCompanionHistory(
            transferId: row['transfer_id']! as String,
            recordingId: row['recording_id']! as int,
            displayName: row['display_name']! as String,
            hash: row['whole_file_sha256']! as String,
            sizeBytes: row['size_bytes']! as int,
            state: row['state']! as String,
            cleanupState: row['source_cleanup_state']! as String,
            createdAtMs: row['created_at_ms']! as int,
            receipt: receiptJson == null
                ? null
                : _receiptFromJson(
                    (jsonDecode(receiptJson) as Map).cast<String, Object?>(),
                  ),
          );
        })
        .toList(growable: false);
  }

  Future<void> deferCleanup(String transferId) async {
    final database = await _database.database;
    await database.update(
      'companion_transfers',
      <String, Object?>{
        'source_cleanup_state': 'deferred',
        'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'transfer_id = ? AND state = ?',
      whereArgs: <Object>[transferId, 'committed'],
    );
  }

  Future<void> deleteSourceAfterReceipt(MobileCompanionHistory history) async {
    if (history.receipt == null || history.state != 'committed') {
      throw const CompanionProtocolException(
        'RECEIPT_REQUIRED',
        'Mobile source cannot be deleted before a desktop receipt.',
      );
    }
    final result = await _deletionCoordinator.permanentlyDelete(
      history.recordingId,
    );
    if (!result.completed) {
      throw const CompanionProtocolException(
        'SOURCE_DELETE_FAILED',
        'Mobile source could not be fully deleted.',
      );
    }
    final database = await _database.database;
    await database.update(
      'companion_transfers',
      <String, Object?>{
        'source_cleanup_state': 'deleted',
        'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'transfer_id = ?',
      whereArgs: <Object>[history.transferId],
    );
  }

  Future<void> unpair(String deviceId) async {
    final database = await _database.database;
    await database.transaction((transaction) async {
      await transaction.update(
        'companion_transfers',
        <String, Object?>{
          'state': 'canceled',
          'updated_at_ms': DateTime.now().millisecondsSinceEpoch,
        },
        where: 'peer_device_id = ? AND state != ?',
        whereArgs: <Object>[deviceId, 'committed'],
      );
      await transaction.update(
        'companion_peers',
        <String, Object?>{
          'trust_state': 'revoked',
          'pending_pairing_id': null,
          'revoked_at_ms': DateTime.now().millisecondsSinceEpoch,
        },
        where: 'device_id = ?',
        whereArgs: <Object>[deviceId],
      );
    });
    await _platform.deleteCredential('peer.$deviceId.credential.v1');
    await _platform.deleteCredential('peer.$deviceId.identity-public-key.v1');
  }
}

String _requiredIdentifier(Object? value, String kind) {
  if (value is! String ||
      !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').hasMatch(value)) {
    throw CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation $kind identifier is invalid.',
    );
  }
  return value;
}

String _requiredDisplayName(Object? value) {
  if (value is! String ||
      value != value.trim() ||
      value.isEmpty ||
      value.length > 256) {
    throw const CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation device name is invalid.',
    );
  }
  return value;
}

String _requiredFingerprint(Object? value) {
  if (value is! String || !RegExp(r'^[A-Z2-7]{20,64}$').hasMatch(value)) {
    throw const CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation fingerprint is invalid.',
    );
  }
  return value;
}

int _requiredInteger(Object? value, String kind) {
  if (value is! int) {
    throw CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation $kind is invalid.',
    );
  }
  return value;
}

List<int> _decodeCanonicalKey(Object? value) {
  if (value is! String || value.isEmpty) {
    throw const CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation public key is invalid.',
    );
  }
  final decoded = base64Decode(value);
  if (decoded.length != 32 || base64Encode(decoded) != value) {
    throw const CompanionProtocolException(
      'PAIRING_INVITE_INVALID',
      'Pairing invitation public key is invalid.',
    );
  }
  return decoded;
}

void _requireMatchingTrust(
  CompanionPeerTrust trust,
  String deviceId,
  String fingerprint,
) {
  if (trust.peerDeviceId != deviceId ||
      trust.peerFingerprint != fingerprint ||
      trust.sharedCredential.length != 32) {
    throw const CompanionProtocolException(
      'PAIRING_TRUST_MISMATCH',
      'Derived trust does not match the pairing invitation.',
    );
  }
}

CompanionReceipt _receiptFromJson(Map<String, Object?> map) {
  return CompanionReceipt(
    receiptId: map['receiptId']! as String,
    transferId: map['transferId']! as String,
    wholeFileSha256: map['wholeFileSha256']! as String,
    sizeBytes: map['sizeBytes']! as int,
    desktopDeviceId: map['desktopDeviceId']! as String,
    desktopDeviceName: map['desktopDeviceName']! as String,
    desktopRecordingId: map['desktopRecordingId']! as int,
    committedAtMs: map['committedAtMs']! as int,
    signature: map['signature']! as String,
  );
}
