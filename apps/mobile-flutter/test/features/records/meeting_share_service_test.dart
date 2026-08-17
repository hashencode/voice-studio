import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';
import 'package:voice2text_flutter/features/records/service/meeting_share_service.dart';

import '../recording/recording_test_database.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'share registers a read-only managed export instead of copying a path',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final repository = RecordingsRepository(database: fixture.appDatabase);
      final commit = await repository.insertImported(
        filePath: '/data/user/0/app/files/meetings/imports/complete/media.m4a',
        displayName: 'media.m4a',
        fingerprintSha256: 'share-me',
        durationMs: 1000,
      );
      const channel = MethodChannel('test/share');
      MethodCall? captured;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            captured = call;
            return <String, Object?>{
              'exportPath':
                  '/data/user/0/app/files/meetings/exports/meeting.m4a',
              'readOnly': true,
            };
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final service = MeetingShareService(
        channel: channel,
        recordingsRepository: repository,
      );

      final receipt = await service.share(
        recordingId: commit.recordingId,
        path: '/data/user/0/app/files/meetings/imports/complete/media.m4a',
        displayName: 'meeting',
      );

      expect(captured?.method, 'shareMeetingFile');
      expect(receipt.readOnly, isTrue);
      final assets = await fixture.database.query('meeting_assets');
      expect(assets, hasLength(1));
      expect(assets.single['kind'], 'share_export');
    },
  );

  test('database registration failure discards the prepared export', () async {
    const channel = MethodChannel('test/share-cleanup');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'discardShareExport') return null;
          return <String, Object?>{
            'exportPath': '/data/user/0/app/files/meetings/exports/meeting.m4a',
            'readOnly': true,
          };
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final service = MeetingShareService(
      channel: channel,
      recordingsRepository: _FailingAssetRepository(),
    );

    await expectLater(
      service.share(
        recordingId: 9,
        path: '/data/user/0/app/files/meetings/recordings/complete/source.m4a',
        displayName: 'meeting',
      ),
      throwsA(isA<StateError>()),
    );
    expect(calls.map((call) => call.method), <String>[
      'shareMeetingFile',
      'discardShareExport',
    ]);
  });
}

class _FailingAssetRepository extends RecordingsRepository {
  @override
  Future<void> registerOwnedAsset({
    required int recordingId,
    required String path,
    required String kind,
  }) async {
    throw StateError('database unavailable');
  }
}
