import 'dart:convert';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_credential_store.dart';
import 'package:voice2text_desktop/features/companion/desktop_companion_repository.dart';

void main() {
  sqfliteFfiInit();

  late Database database;
  late AppDatabase appDatabase;
  late _MemoryCredentialStore credentials;
  late DesktopCompanionRepository repository;

  setUp(() async {
    database = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    await AppDatabase.createCurrentSchema(database);
    appDatabase = AppDatabase.forTesting(database);
    credentials = _MemoryCredentialStore();
    repository = DesktopCompanionRepository(
      database: appDatabase,
      credentialStore: credentials,
    );
  });

  tearDown(() => database.close());

  test('identity and active peer credential stay outside SQLite', () async {
    final first = await repository.identity();
    final second = await repository.identity();
    expect(second.fingerprint, first.fingerprint);
    expect(credentials.values['identity.seed.v1'], hasLength(32));

    await repository.pairPeer(
      deviceId: 'mobile-1',
      displayName: 'Test Phone',
      fingerprint: 'M'.padRight(32, 'M'),
      sharedCredential: List<int>.filled(32, 7),
    );
    final trust = await repository.lookupTrust('mobile-1');
    expect(trust?.sharedCredential, List<int>.filled(32, 7));
    final peerRows = await database.query('companion_peers');
    expect(
      jsonEncode(peerRows),
      isNot(contains(base64Encode(List<int>.filled(32, 7)))),
    );

    await repository.revokePeer('mobile-1');
    expect(await repository.lookupTrust('mobile-1'), isNull);
    expect(credentials.values, isNot(contains('peer.mobile-1.credential.v1')));
  });

  test(
    'manifest, chunks, receipt and recording hash form durable history',
    () async {
      await repository.pairPeer(
        deviceId: 'mobile-1',
        displayName: 'Test Phone',
        fingerprint: 'M'.padRight(32, 'M'),
        sharedCredential: List<int>.filled(32, 7),
      );
      final manifest = CompanionTransferManifest(
        transferId: 'transfer-1',
        sourceAssetId: 'mobile-recording-1',
        displayName: 'meeting.wav',
        sizeBytes: 8,
        wholeFileSha256: 'a'.padRight(64, 'a'),
        chunkBytes: 4096,
        chunkCount: 1,
        createdAtMs: 1,
      );
      await repository.beginTransfer(manifest, 'mobile-1');
      await repository.recordChunk(
        manifest,
        CompanionChunk(
          transferId: manifest.transferId,
          index: 0,
          offset: 0,
          plaintextBytes: 8,
          sha256: 'b'.padRight(64, 'b'),
        ),
      );
      final recordingId = await database.insert('recordings', <String, Object?>{
        'file_path': '/private/meeting.wav',
        'display_name': 'meeting.wav',
        'group_name': null,
        'deleted_at_ms': null,
        'is_favorite': 0,
        'session_id': null,
        'asset_kind': 'imported',
        'fingerprint_sha256': manifest.wholeFileSha256,
        'source_display_name': 'meeting.wav',
        'deletion_state': 'active',
        'duration_ms': 1000,
        'created_at_ms': 2,
      });
      final receipt = CompanionReceipt(
        receiptId: 'receipt-transfer-1',
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        sizeBytes: manifest.sizeBytes,
        desktopDeviceId: 'desktop-1',
        desktopDeviceName: 'Studio Mac',
        desktopRecordingId: recordingId,
        committedAtMs: 3,
        signature: base64Encode(List<int>.filled(64, 1)),
      );
      await repository.recordReceipt(manifest, receipt);
      expect(
        (await repository.receiptFor(manifest))?.desktopRecordingId,
        recordingId,
      );
      final history = await repository.listHistory();
      expect(history.single.state, 'committed');
      expect(history.single.wholeFileSha256, manifest.wholeFileSha256);
      expect(history.single.receipt?.desktopRecordingId, recordingId);
    },
  );
}

class _MemoryCredentialStore implements DesktopCompanionCredentialPort {
  final Map<String, List<int>> values = <String, List<int>>{};

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }

  @override
  Future<List<int>?> read(String key) async => values[key];

  @override
  Future<void> write(String key, List<int> value) async {
    values[key] = List<int>.from(value);
  }
}
