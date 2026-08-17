import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';
import 'package:sqflite/sqflite.dart';

import '../../../data/sqlite/app_database.dart';
import '../../records/model/recording_entity.dart';
import '../../records/repository/recordings_repository.dart';
import '../../records/service/meeting_deletion_coordinator.dart';
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

class MobileCompanionRepository {
  MobileCompanionRepository({
    AppDatabase? database,
    RecordingsRepository? recordingsRepository,
    MeetingDeletionCoordinator? deletionCoordinator,
    CompanionPlatformPort platform = const AndroidCompanionPlatform(),
  }) : _database = database ?? AppDatabase.instance,
       _recordingsRepository =
           recordingsRepository ?? RecordingsRepository(database: database),
       _deletionCoordinator =
           deletionCoordinator ?? MeetingDeletionCoordinator(),
       _platform = platform;

  final AppDatabase _database;
  final RecordingsRepository _recordingsRepository;
  final MeetingDeletionCoordinator _deletionCoordinator;
  final CompanionPlatformPort _platform;

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
      decoded = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(encodedPayload))),
      );
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
    final expected = <String>{
      'schema',
      'type',
      'pairingId',
      'shortCode',
      'desktopDeviceId',
      'desktopDeviceName',
      'desktopFingerprint',
      'sharedCredential',
      'expiresAtMs',
    };
    if (map.keys.toSet().difference(expected).isNotEmpty ||
        expected.difference(map.keys.toSet()).isNotEmpty ||
        map['schema'] != companionMediaTransferSchema ||
        map['type'] != 'pairingInvite' ||
        map['shortCode'] != confirmedShortCode) {
      throw const CompanionProtocolException(
        'PAIRING_CODE_MISMATCH',
        'Pairing short code does not match.',
      );
    }
    final expiresAtMs = map['expiresAtMs'] as int? ?? -1;
    if ((nowMs ?? DateTime.now().millisecondsSinceEpoch) > expiresAtMs) {
      throw const CompanionProtocolException(
        'PAIRING_EXPIRED',
        'Pairing invitation has expired.',
      );
    }
    final deviceId = map['desktopDeviceId'] as String? ?? '';
    final displayName = map['desktopDeviceName'] as String? ?? '';
    final fingerprint = map['desktopFingerprint'] as String? ?? '';
    final pairingId = map['pairingId'] as String? ?? '';
    final List<int> credential;
    try {
      credential = base64Decode(map['sharedCredential'] as String? ?? '');
    } on FormatException {
      throw const CompanionProtocolException(
        'PAIRING_INVITE_INVALID',
        'Pairing invitation credential is invalid.',
      );
    }
    CompanionPeerTrust(
      peerDeviceId: deviceId,
      peerFingerprint: fingerprint,
      sharedCredential: credential,
      pairedAtMs: nowMs ?? DateTime.now().millisecondsSinceEpoch,
    );
    await _platform.putCredential('peer.$deviceId.credential.v1', credential);
    final database = await _database.database;
    final pairedAtMs = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    try {
      await database.insert('companion_peers', <String, Object?>{
        'device_id': deviceId,
        'display_name': displayName,
        'identity_fingerprint': fingerprint,
        'pending_pairing_id': pairingId,
        'trust_state': 'active',
        'paired_at_ms': pairedAtMs,
        'last_seen_at_ms': null,
        'revoked_at_ms': null,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    } catch (_) {
      await _platform.deleteCredential('peer.$deviceId.credential.v1');
      rethrow;
    }
    return MobileCompanionPeer(
      deviceId: deviceId,
      displayName: displayName,
      fingerprint: fingerprint,
      pairedAtMs: pairedAtMs,
      pendingPairingId: pairingId,
    );
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
        'Mobile meeting no longer exists.',
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
    if (credential == null) {
      throw const CompanionProtocolException(
        'PAIRING_REPAIR_REQUIRED',
        'Paired credential is unavailable.',
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
