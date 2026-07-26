import 'dart:convert';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite/sqflite.dart';

import 'desktop_companion_credential_store.dart';

class DesktopCompanionPeer {
  const DesktopCompanionPeer({
    required this.deviceId,
    required this.displayName,
    required this.fingerprint,
    required this.trustState,
    required this.pairedAtMs,
    this.lastSeenAtMs,
  });

  final String deviceId;
  final String displayName;
  final String fingerprint;
  final String trustState;
  final int pairedAtMs;
  final int? lastSeenAtMs;
}

class DesktopCompanionTransferHistory {
  const DesktopCompanionTransferHistory({
    required this.transferId,
    required this.displayName,
    required this.wholeFileSha256,
    required this.sizeBytes,
    required this.state,
    required this.createdAtMs,
    this.recordingId,
    this.receipt,
  });

  final String transferId;
  final String displayName;
  final String wholeFileSha256;
  final int sizeBytes;
  final String state;
  final int createdAtMs;
  final int? recordingId;
  final CompanionReceipt? receipt;
}

class DesktopCompanionRepository {
  const DesktopCompanionRepository({
    required AppDatabase database,
    required DesktopCompanionCredentialPort credentialStore,
  }) : _database = database,
       _credentialStore = credentialStore;

  final AppDatabase _database;
  final DesktopCompanionCredentialPort _credentialStore;

  Future<CompanionIdentity> identity() async {
    var seed = await _credentialStore.read('identity.seed.v1');
    if (seed == null) {
      final generated = await CompanionIdentity.generate();
      seed = generated.privateSeed;
      await _credentialStore.write('identity.seed.v1', seed);
      return generated;
    }
    return CompanionIdentity.fromSeed(seed);
  }

  Future<void> pairPeer({
    required String deviceId,
    required String displayName,
    required String fingerprint,
    required List<int> sharedCredential,
  }) async {
    final trust = CompanionPeerTrust(
      peerDeviceId: deviceId,
      peerFingerprint: fingerprint,
      sharedCredential: sharedCredential,
      pairedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    await _credentialStore.write(
      'peer.${trust.peerDeviceId}.credential.v1',
      trust.sharedCredential,
    );
    final database = await _database.database;
    await database.insert('companion_peers', <String, Object?>{
      'device_id': deviceId,
      'display_name': displayName,
      'identity_fingerprint': fingerprint,
      'pending_pairing_id': null,
      'trust_state': 'active',
      'paired_at_ms': trust.pairedAtMs,
      'last_seen_at_ms': null,
      'revoked_at_ms': null,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<CompanionPeerTrust?> lookupTrust(String deviceId) async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_peers',
      where: 'device_id = ?',
      whereArgs: <Object>[deviceId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.single;
    final credential = await _credentialStore.read(
      'peer.$deviceId.credential.v1',
    );
    if (credential == null) return null;
    return CompanionPeerTrust(
      peerDeviceId: deviceId,
      peerFingerprint: row['identity_fingerprint']! as String,
      sharedCredential: credential,
      pairedAtMs: row['paired_at_ms']! as int,
      revokedAtMs: row['trust_state'] == 'active'
          ? null
          : (row['revoked_at_ms'] as int? ?? row['paired_at_ms']! as int),
    );
  }

  Future<List<DesktopCompanionPeer>> listPeers() async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_peers',
      orderBy: 'paired_at_ms DESC',
    );
    return rows
        .map(
          (row) => DesktopCompanionPeer(
            deviceId: row['device_id']! as String,
            displayName: row['display_name']! as String,
            fingerprint: row['identity_fingerprint']! as String,
            trustState: row['trust_state']! as String,
            pairedAtMs: row['paired_at_ms']! as int,
            lastSeenAtMs: row['last_seen_at_ms'] as int?,
          ),
        )
        .toList(growable: false);
  }

  Future<void> revokePeer(String deviceId) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.transaction((transaction) async {
      await transaction.update(
        'companion_peers',
        <String, Object?>{'trust_state': 'revoked', 'revoked_at_ms': now},
        where: 'device_id = ?',
        whereArgs: <Object>[deviceId],
      );
      await transaction.delete(
        'companion_transfer_chunks',
        where:
            'transfer_id IN ('
            'SELECT transfer_id FROM companion_transfers '
            'WHERE peer_device_id = ?'
            ')',
        whereArgs: <Object>[deviceId],
      );
      await transaction.update(
        'companion_transfers',
        <String, Object?>{
          'receipt_json': null,
          'state': 'canceled',
          'updated_at_ms': now,
        },
        where: 'peer_device_id = ? AND state != ?',
        whereArgs: <Object>[deviceId, 'committed'],
      );
      await transaction.update(
        'companion_transfers',
        <String, Object?>{'receipt_json': null, 'updated_at_ms': now},
        where: 'peer_device_id = ? AND state = ?',
        whereArgs: <Object>[deviceId, 'committed'],
      );
    });
    await _credentialStore.delete('peer.$deviceId.credential.v1');
  }

  Future<void> beginTransfer(
    CompanionTransferManifest manifest,
    String peerDeviceId,
  ) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.insert('companion_transfers', <String, Object?>{
      'transfer_id': manifest.transferId,
      'whole_file_sha256': manifest.wholeFileSha256,
      'direction': 'receive',
      'peer_device_id': peerDeviceId,
      'source_asset_id': manifest.sourceAssetId,
      'display_name': manifest.displayName,
      'size_bytes': manifest.sizeBytes,
      'chunk_bytes': manifest.chunkBytes,
      'chunk_count': manifest.chunkCount,
      'state': 'transferring',
      'recording_id': null,
      'receipt_json': null,
      'source_cleanup_state': 'not_applicable',
      'created_at_ms': now,
      'updated_at_ms': now,
      'completed_at_ms': null,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  Future<void> recordChunk(
    CompanionTransferManifest manifest,
    CompanionChunk chunk,
  ) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.transaction((transaction) async {
      await transaction.insert('companion_transfer_chunks', <String, Object?>{
        'transfer_id': manifest.transferId,
        'whole_file_sha256': manifest.wholeFileSha256,
        'chunk_index': chunk.index,
        'chunk_sha256': chunk.sha256,
        'plaintext_bytes': chunk.plaintextBytes,
        'received_at_ms': now,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      await transaction.update(
        'companion_transfers',
        <String, Object?>{'state': 'transferring', 'updated_at_ms': now},
        where: 'transfer_id = ? AND whole_file_sha256 = ?',
        whereArgs: <Object>[manifest.transferId, manifest.wholeFileSha256],
      );
    });
  }

  Future<CompanionReceipt?> receiptFor(
    CompanionTransferManifest manifest,
  ) async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_transfers',
      columns: <String>['receipt_json'],
      where: 'transfer_id = ? AND whole_file_sha256 = ?',
      whereArgs: <Object>[manifest.transferId, manifest.wholeFileSha256],
      limit: 1,
    );
    if (rows.isEmpty || rows.single['receipt_json'] == null) return null;
    return _receiptFromJson(
      (jsonDecode(rows.single['receipt_json']! as String) as Map)
          .cast<String, Object?>(),
    );
  }

  Future<void> recordReceipt(
    CompanionTransferManifest manifest,
    CompanionReceipt receipt,
  ) async {
    final database = await _database.database;
    await database.update(
      'companion_transfers',
      <String, Object?>{
        'state': 'committed',
        'recording_id': receipt.desktopRecordingId,
        'receipt_json': jsonEncode(receipt.toJson()),
        'updated_at_ms': receipt.committedAtMs,
        'completed_at_ms': receipt.committedAtMs,
      },
      where: 'transfer_id = ? AND whole_file_sha256 = ?',
      whereArgs: <Object>[manifest.transferId, manifest.wholeFileSha256],
    );
  }

  Future<List<CompanionTransferManifest>> unfinishedTransfers({
    String? peerDeviceId,
    int? updatedBeforeMs,
  }) async {
    final database = await _database.database;
    final clauses = <String>['state NOT IN (?, ?, ?)'];
    final arguments = <Object>['committed', 'canceled', 'expired'];
    if (peerDeviceId != null) {
      clauses.add('peer_device_id = ?');
      arguments.add(peerDeviceId);
    }
    if (updatedBeforeMs != null) {
      clauses.add('updated_at_ms <= ?');
      arguments.add(updatedBeforeMs);
    }
    final rows = await database.query(
      'companion_transfers',
      where: clauses.join(' AND '),
      whereArgs: arguments,
    );
    return rows
        .map(
          (row) => CompanionTransferManifest(
            transferId: row['transfer_id']! as String,
            sourceAssetId: row['source_asset_id']! as String,
            displayName: row['display_name']! as String,
            sizeBytes: row['size_bytes']! as int,
            wholeFileSha256: row['whole_file_sha256']! as String,
            chunkBytes: row['chunk_bytes']! as int,
            chunkCount: row['chunk_count']! as int,
            createdAtMs: row['created_at_ms']! as int,
          ),
        )
        .toList(growable: false);
  }

  Future<void> expireTransfer(CompanionTransferManifest manifest) async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.transaction((transaction) async {
      await transaction.delete(
        'companion_transfer_chunks',
        where: 'transfer_id = ? AND whole_file_sha256 = ?',
        whereArgs: <Object>[manifest.transferId, manifest.wholeFileSha256],
      );
      await transaction.update(
        'companion_transfers',
        <String, Object?>{
          'state': 'expired',
          'receipt_json': null,
          'updated_at_ms': now,
        },
        where: 'transfer_id = ? AND whole_file_sha256 = ? AND state != ?',
        whereArgs: <Object>[
          manifest.transferId,
          manifest.wholeFileSha256,
          'committed',
        ],
      );
    });
  }

  Future<List<DesktopCompanionTransferHistory>> listHistory() async {
    final database = await _database.database;
    final rows = await database.query(
      'companion_transfers',
      orderBy: 'created_at_ms DESC',
      limit: 100,
    );
    return rows
        .map((row) {
          final receiptJson = row['receipt_json'] as String?;
          return DesktopCompanionTransferHistory(
            transferId: row['transfer_id']! as String,
            displayName: row['display_name']! as String,
            wholeFileSha256: row['whole_file_sha256']! as String,
            sizeBytes: row['size_bytes']! as int,
            state: row['state']! as String,
            createdAtMs: row['created_at_ms']! as int,
            recordingId: row['recording_id'] as int?,
            receipt: receiptJson == null
                ? null
                : _receiptFromJson(
                    (jsonDecode(receiptJson) as Map).cast<String, Object?>(),
                  ),
          );
        })
        .toList(growable: false);
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
