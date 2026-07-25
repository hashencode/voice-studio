import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/importing/service/meeting_import_service.dart';
import 'package:voice2text_flutter/features/records/repository/recordings_repository.dart';

import '../recording/recording_test_database.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('validated import commits one recording and one pending job', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    const channel = MethodChannel('test/import');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return <String, Object?>{
            'path': '/data/user/0/app/files/meetings/imports/complete/a.m4a',
            'displayName': '会议.m4a',
            'mimeType': 'audio/mp4',
            'sizeBytes': 4096,
            'durationMs': 12_000,
            'fingerprintSha256': 'abc123',
            'duplicateAsset': calls.length > 1,
          };
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final service = MeetingImportService(
      channel: channel,
      recordingsRepository: RecordingsRepository(database: fixture.appDatabase),
    );

    final first = await service.pickAndImport();
    final second = await service.pickAndImport();

    expect(first?.inserted, isTrue);
    expect(first?.transcriptionJobId, isNotNull);
    expect(second?.inserted, isFalse);
    expect(second?.recordingId, first?.recordingId);
    expect(await fixture.database.query('recordings'), hasLength(1));
    final jobs = await fixture.database.query('transcription_jobs');
    expect(jobs, hasLength(1));
    expect(jobs.single['status'], 'pending');
    expect(jobs.single['source'], 'import_offline');
  });

  test('duplicate fingerprint discards a newly copied alternate path', () async {
    final fixture = await openRecordingTestDatabase();
    addTearDown(fixture.database.close);
    final repository = RecordingsRepository(database: fixture.appDatabase);
    final existing = await repository.insertImported(
      filePath: '/data/user/0/app/files/meetings/imports/complete/original.m4a',
      displayName: '原始文件.m4a',
      fingerprintSha256: 'same-content',
      durationMs: 12_000,
    );
    const channel = MethodChannel('test/import-duplicate-path');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'discardImportedMedia') return null;
          return <String, Object?>{
            'path':
                '/data/user/0/app/files/meetings/imports/complete/alternate.mp4',
            'displayName': '另一个名字.mp4',
            'mimeType': 'video/mp4',
            'sizeBytes': 4096,
            'durationMs': 12_000,
            'fingerprintSha256': 'same-content',
            'duplicateAsset': false,
          };
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final service = MeetingImportService(
      channel: channel,
      recordingsRepository: repository,
    );

    final outcome = await service.pickAndImport();

    expect(outcome?.inserted, isFalse);
    expect(outcome?.recordingId, existing.recordingId);
    expect(calls.map((call) => call.method), <String>[
      'pickMeetingMedia',
      'discardImportedMedia',
    ]);
    expect(
      (calls.last.arguments as Map<Object?, Object?>)['path'],
      '/data/user/0/app/files/meetings/imports/complete/alternate.mp4',
    );
  });

  test('cancel requests native copy cancellation', () async {
    const channel = MethodChannel('test/import-cancel');
    MethodCall? captured;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          captured = call;
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final service = MeetingImportService(channel: channel);

    await service.cancelImport();

    expect(captured?.method, 'cancelMeetingImport');
  });

  test(
    'shared media reuses validated import commit and queue creation',
    () async {
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      const channel = MethodChannel('test/shared-import');
      MethodCall? captured;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            captured = call;
            return <String, Object?>{
              'path':
                  '/data/user/0/app/files/meetings/imports/complete/shared.m4a',
              'displayName': '来自相册.m4a',
              'mimeType': 'audio/mp4',
              'sizeBytes': 8192,
              'durationMs': 30_000,
              'fingerprintSha256': 'shared-media',
              'duplicateAsset': false,
            };
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final service = MeetingImportService(
        channel: channel,
        recordingsRepository: RecordingsRepository(
          database: fixture.appDatabase,
        ),
      );

      final outcome = await service.consumeSharedImport();

      expect(captured?.method, 'consumeSharedMeetingMedia');
      expect(outcome?.inserted, isTrue);
      expect(outcome?.transcriptionJobId, isNotNull);
      expect(await fixture.database.query('recordings'), hasLength(1));
      expect(await fixture.database.query('transcription_jobs'), hasLength(1));
    },
  );

  test(
    'native warm-share notification reaches the shared media stream',
    () async {
      const channel = MethodChannel('test/shared-import-events');
      final service = MeetingImportService(channel: channel);
      addTearDown(service.dispose);
      final notified = service.sharedMediaAvailable.first;

      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('sharedMeetingMediaAvailable'),
            ),
            (_) {},
          );

      await notified;
    },
  );
}
