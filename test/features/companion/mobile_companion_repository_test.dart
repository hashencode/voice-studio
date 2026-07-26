import 'dart:convert';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_flutter/data/sqlite/app_database.dart';
import 'package:voice2text_flutter/features/companion/repository/mobile_companion_repository.dart';
import 'package:voice2text_flutter/features/companion/service/android_companion_platform.dart';

void main() {
  sqfliteFfiInit();

  late Database database;
  late AppDatabase appDatabase;
  late _MemoryCompanionPlatform platform;
  late MobileCompanionRepository repository;

  setUp(() async {
    database = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    await AppDatabase.createCurrentSchema(database);
    appDatabase = AppDatabase.forTesting(database);
    platform = _MemoryCompanionPlatform();
    repository = MobileCompanionRepository(
      database: appDatabase,
      platform: platform,
    );
  });

  tearDown(() => database.close());

  test(
    'pairing invitation requires matching short code and stays bounded',
    () async {
      final payload = _invite(code: '123456');
      await expectLater(
        repository.acceptPairingInvite(
          encodedPayload: payload,
          confirmedShortCode: '000000',
          nowMs: 1000,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PAIRING_CODE_MISMATCH',
          ),
        ),
      );
      expect(await database.query('companion_peers'), isEmpty);

      final peer = await repository.acceptPairingInvite(
        encodedPayload: payload,
        confirmedShortCode: '123456',
        nowMs: 1000,
      );
      expect(peer.deviceId, 'desktop-1');
      expect(peer.pendingPairingId, 'pairing-1');
      expect(
        platform.values['peer.desktop-1.credential.v1'],
        List<int>.filled(32, 9),
      );
      final row = (await database.query('companion_peers')).single;
      expect(row['identity_fingerprint'], 'D'.padRight(32, 'D'));
      expect(jsonEncode(row), isNot(contains('CQkJCQkJ')));
    },
  );

  test(
    'expired invitation and unpair fail closed without deleting meetings',
    () async {
      await expectLater(
        repository.acceptPairingInvite(
          encodedPayload: _invite(code: '123456', expiresAtMs: 999),
          confirmedShortCode: '123456',
          nowMs: 1000,
        ),
        throwsA(
          isA<CompanionProtocolException>().having(
            (error) => error.code,
            'code',
            'PAIRING_EXPIRED',
          ),
        ),
      );
      await repository.acceptPairingInvite(
        encodedPayload: _invite(code: '123456'),
        confirmedShortCode: '123456',
        nowMs: 1000,
      );
      await database.insert('recordings', <String, Object?>{
        'file_path': '/private/mobile.wav',
        'display_name': 'Mobile meeting',
        'group_name': null,
        'deleted_at_ms': null,
        'is_favorite': 0,
        'session_id': null,
        'asset_kind': 'recording',
        'fingerprint_sha256': 'a'.padRight(64, 'a'),
        'source_display_name': 'Mobile meeting',
        'deletion_state': 'active',
        'duration_ms': 1000,
        'created_at_ms': 1,
      });
      await repository.unpair('desktop-1');
      expect(platform.values['peer.desktop-1.credential.v1'], isNull);
      expect(await database.query('recordings'), hasLength(1));
      expect(
        (await database.query('companion_peers')).single['trust_state'],
        'revoked',
      );
    },
  );
}

String _invite({required String code, int expiresAtMs = 2000}) {
  final payload = <String, Object>{
    'schema': companionMediaTransferSchema,
    'type': 'pairingInvite',
    'pairingId': 'pairing-1',
    'shortCode': code,
    'desktopDeviceId': 'desktop-1',
    'desktopDeviceName': 'Studio Mac',
    'desktopFingerprint': 'D'.padRight(32, 'D'),
    'sharedCredential': base64Encode(List<int>.filled(32, 9)),
    'expiresAtMs': expiresAtMs,
  };
  return base64UrlEncode(utf8.encode(jsonEncode(payload)));
}

class _MemoryCompanionPlatform implements CompanionPlatformPort {
  final Map<String, List<int>> values = <String, List<int>>{};

  @override
  Future<void> deleteAllCredentials() async => values.clear();

  @override
  Future<void> deleteCredential(String key) async => values.remove(key);

  @override
  Future<List<int>?> getCredential(String key) async => values[key];

  @override
  Future<List<DiscoveredCompanionDesktop>> listDiscoveredDesktops() async =>
      const <DiscoveredCompanionDesktop>[];

  @override
  Future<void> putCredential(String key, List<int> value) async {
    values[key] = List<int>.from(value);
  }

  @override
  Future<void> startDiscovery() async {}

  @override
  Future<void> stopDiscovery() async {}
}
