import 'dart:convert';
import 'dart:io';
import 'dart:async';

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

  setUp(() async {
    database = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    await AppDatabase.createCurrentSchema(database);
    appDatabase = AppDatabase.forTesting(database);
    platform = _MemoryCompanionPlatform();
  });

  tearDown(() => database.close());

  MobileCompanionRepository repository(MobileCompanionPairingRunner runner) {
    return MobileCompanionRepository(
      database: appDatabase,
      platform: platform,
      pairingRunner: runner,
    );
  }

  test(
    'default runner pairs with Electron fixture through public artifact',
    () async {
      final repositoryRoot = Directory.current.parent.parent;
      final electronRoot = Directory(
        '${repositoryRoot.path}/apps/desktop-electron',
      );
      final temporary = await Directory.systemTemp.createTemp(
        'voice2text-mobile-pairing-interop-',
      );
      final process = await Process.start('node', <String>[
        '--no-warnings',
        '--experimental-strip-types',
        '--loader',
        '${electronRoot.path}/tests/fixtures/typescript_loader.mjs',
        '${electronRoot.path}/tests/fixtures/companion_pairing_host.ts',
        '${temporary.path}/transfers',
      ], workingDirectory: electronRoot.path);
      final stderr = StringBuffer();
      final stderrDone = process.stderr
          .transform(utf8.decoder)
          .listen(stderr.write)
          .asFuture<void>();
      final stdoutLines = StreamIterator<String>(
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      try {
        if (!await stdoutLines.moveNext().timeout(
          const Duration(seconds: 15),
        )) {
          fail('Electron pairing fixture did not publish an invitation.');
        }
        final internalInvite = (jsonDecode(stdoutLines.current) as Map)
            .cast<String, Object?>();
        final publicArtifact = jsonEncode(<String, Object?>{
          'schema': companionMediaTransferSchema,
          'pairingId': internalInvite['pairingId'],
          'targetDeviceId': internalInvite['targetDeviceId'],
          'targetDeviceName': 'Voice2Text Mac',
          'targetFingerprint': internalInvite['targetFingerprint'],
          'targetIdentityPublicKey': internalInvite['targetIdentityPublicKey'],
          'targetEphemeralPublicKey':
              internalInvite['targetEphemeralPublicKey'],
          'host': '127.0.0.1',
          'port': internalInvite['port'],
          'expiresAtMs': internalInvite['expiresAtMs'],
        });
        expect(publicArtifact, isNot(contains('shortCode')));
        expect(publicArtifact, isNot(contains('sharedCredential')));

        final subject = MobileCompanionRepository(
          database: appDatabase,
          platform: platform,
        );
        final peer = await subject.acceptPairingInvite(
          encodedPayload: publicArtifact,
          confirmedShortCode: internalInvite['shortCode']! as String,
        );

        expect(peer.deviceId, internalInvite['targetDeviceId']);
        expect((await subject.listPeers()), hasLength(1));
        expect(
          (await database.query('companion_peers')).single['trust_state'],
          'active',
        );
      } finally {
        await stdoutLines.cancel();
        process.kill(ProcessSignal.sigterm);
        await process.exitCode.timeout(const Duration(seconds: 5));
        await stderrDone;
        if (stderr.isNotEmpty) {
          // Retained for failure diagnostics without leaking pairing material.
          stderr.clear();
        }
        await temporary.delete(recursive: true);
      }
    },
  );

  test(
    'Electron public v2 artifact derives and activates paired trust',
    () async {
      final artifact = await _artifact();
      late CompanionSocketPairingClient observedClient;
      final subject = repository(({
        required client,
        required address,
        required port,
      }) async {
        observedClient = client;
        expect(address, InternetAddress.loopbackIPv4);
        expect(port, 42424);
        final trust = _trustFor(client);
        await client.persistPendingTrust(trust);
        return trust;
      });

      final peer = await subject.acceptPairingInvite(
        encodedPayload: artifact.rawJson,
        confirmedShortCode: '123456',
        nowMs: 1000,
      );

      expect(peer.deviceId, 'desktop-1');
      expect(peer.displayName, 'Studio Mac');
      expect(peer.pendingPairingId, 'pairing-1');
      expect(observedClient.shortCode, '123456');
      expect(observedClient.targetFingerprint, artifact.fingerprint);
      expect(
        platform.values['peer.desktop-1.credential.v1'],
        List<int>.filled(32, 9),
      );
      expect(
        platform.values['peer.desktop-1.identity-public-key.v1'],
        artifact.identityPublicKey,
      );
      final row = (await database.query('companion_peers')).single;
      expect(row['identity_fingerprint'], artifact.fingerprint);
      expect(row['trust_state'], 'active');
      expect(
        jsonEncode(row),
        isNot(contains(base64Encode(List<int>.filled(32, 9)))),
      );
    },
  );

  test('legacy and secret-bearing artifacts reject before any write', () async {
    var networkCalls = 0;
    final subject = repository(({
      required client,
      required address,
      required port,
    }) async {
      networkCalls += 1;
      throw StateError('must not connect');
    });
    final valid = await _artifact();
    final validMap = (jsonDecode(valid.rawJson) as Map).cast<String, Object?>();
    final cases = <Map<String, Object?>>[
      <String, Object?>{...validMap, 'schema': 'companion-media-transfer/v1'},
      <String, Object?>{
        ...validMap,
        'sharedCredential': base64Encode(List<int>.filled(32, 9)),
      },
      <String, Object?>{...validMap, 'shortCode': '123456'},
    ];

    for (final artifact in cases) {
      await expectLater(
        subject.acceptPairingInvite(
          encodedPayload: jsonEncode(artifact),
          confirmedShortCode: '123456',
          nowMs: 1000,
        ),
        throwsA(isA<CompanionProtocolException>()),
      );
    }

    expect(networkCalls, 0);
    expect(platform.values, isEmpty);
    expect(await database.query('companion_peers'), isEmpty);
  });

  test(
    'expiry, shortcode, and public key reject before identity mutation',
    () async {
      var networkCalls = 0;
      final subject = repository(({
        required client,
        required address,
        required port,
      }) async {
        networkCalls += 1;
        throw StateError('must not connect');
      });
      final valid = await _artifact();
      final validMap = (jsonDecode(valid.rawJson) as Map)
          .cast<String, Object?>();
      final expired = <String, Object?>{...validMap, 'expiresAtMs': 999};
      final farFuture = <String, Object?>{...validMap, 'expiresAtMs': 126001};
      final badKey = <String, Object?>{
        ...validMap,
        'targetIdentityPublicKey': base64Encode(List<int>.filled(31, 1)),
      };
      final badPortType = <String, Object?>{...validMap, 'port': '42424'};

      for (final input in <({String payload, String code})>[
        (payload: jsonEncode(expired), code: '123456'),
        (payload: jsonEncode(farFuture), code: '123456'),
        (payload: jsonEncode(badKey), code: '123456'),
        (payload: jsonEncode(badPortType), code: '123456'),
        (payload: valid.rawJson, code: '12 456'),
      ]) {
        await expectLater(
          subject.acceptPairingInvite(
            encodedPayload: input.payload,
            confirmedShortCode: input.code,
            nowMs: 1000,
          ),
          throwsA(isA<CompanionProtocolException>()),
        );
      }

      expect(networkCalls, 0);
      expect(platform.values, isEmpty);
      expect(await database.query('companion_peers'), isEmpty);
    },
  );

  test('lost final acknowledgement keeps recoverable pending trust', () async {
    final artifact = await _artifact();
    final subject = repository(({
      required client,
      required address,
      required port,
    }) async {
      await client.persistPendingTrust(_trustFor(client));
      throw const CompanionProtocolException(
        'PAIRING_CONFIRMATION_UNKNOWN',
        'confirmation lost',
      );
    });

    await expectLater(
      subject.acceptPairingInvite(
        encodedPayload: artifact.rawJson,
        confirmedShortCode: '123456',
        nowMs: 1000,
      ),
      throwsA(
        isA<CompanionProtocolException>().having(
          (error) => error.code,
          'code',
          'PAIRING_CONFIRMATION_UNKNOWN',
        ),
      ),
    );

    final row = (await database.query('companion_peers')).single;
    expect(row['trust_state'], 'repair_required');
    expect(row['pending_pairing_id'], 'pairing-1');
    expect(
      platform.values['peer.desktop-1.pairing.pairing-1.credential.v1'],
      isNotNull,
    );
    expect(
      platform
          .values['peer.desktop-1.pairing.pairing-1.identity-public-key.v1'],
      isNotNull,
    );
    expect(await subject.listPeers(), isEmpty);
  });

  test(
    're-pair lost acknowledgement preserves existing active trust',
    () async {
      final artifact = await _artifact();
      const canonicalCredentialKey = 'peer.desktop-1.credential.v1';
      const canonicalIdentityKey = 'peer.desktop-1.identity-public-key.v1';
      final previousCredential = List<int>.filled(32, 4);
      final previousIdentity = List<int>.filled(32, 5);
      platform.values[canonicalCredentialKey] = previousCredential;
      platform.values[canonicalIdentityKey] = previousIdentity;
      await database.insert('companion_peers', <String, Object?>{
        'device_id': 'desktop-1',
        'display_name': 'Existing Studio Mac',
        'identity_fingerprint': 'A'.padRight(20, 'A'),
        'pending_pairing_id': null,
        'trust_state': 'active',
        'paired_at_ms': 1,
        'last_seen_at_ms': null,
        'revoked_at_ms': null,
      });
      final subject = repository(({
        required client,
        required address,
        required port,
      }) async {
        await client.persistPendingTrust(_trustFor(client));
        throw const CompanionProtocolException(
          'PAIRING_CONFIRMATION_UNKNOWN',
          'confirmation lost',
        );
      });

      await expectLater(
        subject.acceptPairingInvite(
          encodedPayload: artifact.rawJson,
          confirmedShortCode: '123456',
          nowMs: 1000,
        ),
        throwsA(isA<CompanionProtocolException>()),
      );

      expect(platform.values[canonicalCredentialKey], previousCredential);
      expect(platform.values[canonicalIdentityKey], previousIdentity);
      expect(await subject.listPeers(), hasLength(1));
      final row = (await database.query('companion_peers')).single;
      expect(row['trust_state'], 'active');
      expect(row['pending_pairing_id'], 'pairing-1');
      expect(
        platform.values['peer.desktop-1.pairing.pairing-1.credential.v1'],
        List<int>.filled(32, 9),
      );
      expect(
        platform
            .values['peer.desktop-1.pairing.pairing-1.identity-public-key.v1'],
        artifact.identityPublicKey,
      );
    },
  );

  test(
    'promotion write failure restores existing active trust and credentials',
    () async {
      final artifact = await _artifact();
      const canonicalCredentialKey = 'peer.desktop-1.credential.v1';
      const canonicalIdentityKey = 'peer.desktop-1.identity-public-key.v1';
      final previousCredential = List<int>.filled(32, 4);
      final previousIdentity = List<int>.filled(32, 5);
      platform.values[canonicalCredentialKey] = previousCredential;
      platform.values[canonicalIdentityKey] = previousIdentity;
      platform.failPutForKey = canonicalIdentityKey;
      await database.insert('companion_peers', <String, Object?>{
        'device_id': 'desktop-1',
        'display_name': 'Existing Studio Mac',
        'identity_fingerprint': 'A'.padRight(20, 'A'),
        'pending_pairing_id': null,
        'trust_state': 'active',
        'paired_at_ms': 1,
        'last_seen_at_ms': null,
        'revoked_at_ms': null,
      });
      final subject = repository(({
        required client,
        required address,
        required port,
      }) async {
        final trust = _trustFor(client);
        await client.persistPendingTrust(trust);
        return trust;
      });

      await expectLater(
        subject.acceptPairingInvite(
          encodedPayload: artifact.rawJson,
          confirmedShortCode: '123456',
          nowMs: 1000,
        ),
        throwsA(isA<StateError>()),
      );

      expect(platform.values[canonicalCredentialKey], previousCredential);
      expect(platform.values[canonicalIdentityKey], previousIdentity);
      final row = (await database.query('companion_peers')).single;
      expect(row['display_name'], 'Existing Studio Mac');
      expect(row['trust_state'], 'active');
      expect(row['pending_pairing_id'], 'pairing-1');
    },
  );

  test(
    'failure before verified transcript does not persist peer trust',
    () async {
      final artifact = await _artifact();
      final subject = repository(({
        required client,
        required address,
        required port,
      }) async {
        throw const CompanionProtocolException('PAIRING_FAILED', 'failed');
      });

      await expectLater(
        subject.acceptPairingInvite(
          encodedPayload: artifact.rawJson,
          confirmedShortCode: '123456',
          nowMs: 1000,
        ),
        throwsA(isA<CompanionProtocolException>()),
      );

      expect(await database.query('companion_peers'), isEmpty);
      expect(platform.values['peer.desktop-1.credential.v1'], isNull);
      expect(platform.values['peer.desktop-1.identity-public-key.v1'], isNull);
    },
  );

  test('unpair removes derived trust without deleting audios', () async {
    final artifact = await _artifact();
    final subject = repository(({
      required client,
      required address,
      required port,
    }) async {
      final trust = _trustFor(client);
      await client.persistPendingTrust(trust);
      return trust;
    });
    await subject.acceptPairingInvite(
      encodedPayload: artifact.rawJson,
      confirmedShortCode: '123456',
      nowMs: 1000,
    );
    await database.insert('recordings', <String, Object?>{
      'file_path': '/private/mobile.wav',
      'display_name': 'Mobile audio',
      'group_name': null,
      'deleted_at_ms': null,
      'is_favorite': 0,
      'session_id': null,
      'asset_kind': 'recording',
      'fingerprint_sha256': 'a'.padRight(64, 'a'),
      'source_display_name': 'Mobile audio',
      'deletion_state': 'active',
      'duration_ms': 1000,
      'created_at_ms': 1,
    });

    await subject.unpair('desktop-1');

    expect(platform.values['peer.desktop-1.credential.v1'], isNull);
    expect(platform.values['peer.desktop-1.identity-public-key.v1'], isNull);
    expect(
      platform.values['peer.desktop-1.pairing.pairing-1.credential.v1'],
      isNull,
    );
    expect(
      platform
          .values['peer.desktop-1.pairing.pairing-1.identity-public-key.v1'],
      isNull,
    );
    expect(await database.query('recordings'), hasLength(1));
    expect(
      (await database.query('companion_peers')).single['trust_state'],
      'revoked',
    );
  });
}

CompanionPeerTrust _trustFor(CompanionSocketPairingClient client) {
  return CompanionPeerTrust(
    peerDeviceId: client.targetDeviceId,
    peerFingerprint: client.targetFingerprint,
    sharedCredential: List<int>.filled(32, 9),
    pairedAtMs: 1000,
  );
}

Future<_PairingArtifact> _artifact() async {
  final identity = await CompanionIdentity.fromSeed(List<int>.filled(32, 3));
  final ephemeral = await CompanionPairingEphemeral.generate();
  final identityBytes = List<int>.from(identity.publicKey.bytes);
  final ephemeralBytes = List<int>.from(ephemeral.publicKey.bytes);
  ephemeral.destroy();
  return _PairingArtifact(
    rawJson: jsonEncode(<String, Object?>{
      'schema': companionMediaTransferSchema,
      'pairingId': 'pairing-1',
      'targetDeviceId': 'desktop-1',
      'targetDeviceName': 'Studio Mac',
      'targetFingerprint': identity.fingerprint,
      'targetIdentityPublicKey': base64Encode(identityBytes),
      'targetEphemeralPublicKey': base64Encode(ephemeralBytes),
      'host': '127.0.0.1',
      'port': 42424,
      'expiresAtMs': 121000,
    }),
    fingerprint: identity.fingerprint,
    identityPublicKey: identityBytes,
  );
}

class _PairingArtifact {
  const _PairingArtifact({
    required this.rawJson,
    required this.fingerprint,
    required this.identityPublicKey,
  });

  final String rawJson;
  final String fingerprint;
  final List<int> identityPublicKey;
}

class _MemoryCompanionPlatform implements CompanionPlatformPort {
  final Map<String, List<int>> values = <String, List<int>>{};
  String? failPutForKey;

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
    if (key == failPutForKey) {
      throw StateError('credential write failed for $key');
    }
    values[key] = List<int>.from(value);
  }

  @override
  Future<void> startDiscovery() async {}

  @override
  Future<void> stopDiscovery() async {}
}
