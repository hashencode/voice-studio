import 'dart:convert';
import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:voice2text_flutter/features/help/model/diagnostic_report.dart';
import 'package:voice2text_flutter/features/help/service/diagnostic_report_service.dart';
import 'package:voice2text_flutter/features/help/service/diagnostic_share_service.dart';
import 'package:voice2text_flutter/features/shared/service/ephemeral_share_artifact_service.dart';

import '../recording/recording_test_database.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'report aggregates allowlisted metadata without reading meeting payloads',
    () async {
      const channel = MethodChannel('diagnostic-report-test');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      messenger.setMockMethodCallHandler(channel, (call) async {
        return switch (call.method) {
          'getBuildInfo' => <String, Object?>{
            'packageName': 'com.voice2text.app',
            'versionName': '1.2.3+4',
            'deviceSerial': 'stable-device-secret',
          },
          'getDeviceProtection' => <String, Object?>{
            'storageScope': 'app_private_internal',
            'protectionCategory': 'device_security_managed',
            'applicationLayerEncryption': false,
            'platformEncryptionStatus': 'not_exposed',
            'backupPolicy': 'app_data_excluded',
            'androidId': 'stable-android-id',
          },
          _ => null,
        };
      });
      final fixture = await openRecordingTestDatabase();
      addTearDown(fixture.database.close);
      final recordingId = await fixture.database
          .insert('recordings', <String, Object?>{
            'file_path': '/data/user/0/private/secret-meeting.m4a',
            'display_name': '董事会秘密会议',
            'duration_ms': 1000,
            'created_at_ms': 1,
          });
      await _insertJob(
        fixture.database,
        recordingId: recordingId,
        status: 'completed',
        stage: 'completed',
        errorCode: null,
        startedAtMs: 100,
        completedAtMs: 600,
      );
      await _insertJob(
        fixture.database,
        recordingId: recordingId,
        status: 'failed',
        stage: 'failed',
        errorCode: '/data/user/0/private/secret',
        startedAtMs: 700,
        completedAtMs: 1000,
      );
      final service = DiagnosticReportService(
        database: fixture.appDatabase,
        channel: channel,
        now: () => DateTime.fromMillisecondsSinceEpoch(2000),
      );

      final report = await service.build();
      final encoded = report.toPrettyJson();

      expect(report.generatedAtMs, 2000);
      expect(report.build.packageName, 'com.voice2text.app');
      expect(report.build.versionName, '1.2.3+4');
      expect(report.deviceProtection.protectionSummary, '由设备安全设置保护');
      expect(report.deviceProtection.applicationLayerEncryption, isFalse);
      expect(report.transcription.statusCounts, <String, int>{
        'completed': 1,
        'failed': 1,
      });
      expect(report.transcription.errorCategoryCounts, <String, int>{
        'OTHER': 1,
      });
      expect(report.transcription.timedJobCount, 2);
      expect(report.transcription.averageProcessingMs, 400);
      expect(report.transcription.maximumProcessingMs, 500);
      for (final forbidden in <String>[
        'secret-meeting',
        '董事会秘密会议',
        '敏感转写正文',
        'content://private/error',
        '/data/user/0',
        'stable-device-secret',
        'stable-android-id',
      ]) {
        expect(encoded, isNot(contains(forbidden)));
      }
      expect(
        (jsonDecode(encoded) as Map<String, Object?>).keys,
        unorderedEquals(<String>[
          'schemaVersion',
          'generatedAtMs',
          'build',
          'deviceProtection',
          'transcription',
          'privacy',
        ]),
      );
    },
  );

  test(
    'diagnostic ZIP contains only report and manifest and shares read-only',
    () async {
      const channel = MethodChannel('diagnostic-share-test');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final root = await Directory.systemTemp.createTemp('diagnostic-share-');
      addTearDown(() async {
        messenger.setMockMethodCallHandler(channel, null);
        await root.delete(recursive: true);
      });
      MethodCall? observed;
      messenger.setMockMethodCallHandler(channel, (call) async {
        observed = call;
        return <String, Object?>{'readOnly': true};
      });
      final artifactService = EphemeralShareArtifactService(
        rootDirectory: root,
        channel: channel,
        now: () => DateTime.fromMillisecondsSinceEpoch(2000),
      );
      final shareService = DiagnosticShareService(
        artifactService: artifactService,
      );
      final report = _report();

      final built = await shareService.build(report);
      final archive = ZipDecoder().decodeBytes(
        await File(built.artifact.path).readAsBytes(),
      );
      final names = archive.files.map((entry) => entry.name).toList();
      expect(
        names,
        unorderedEquals(<String>['diagnostic-report.json', 'manifest.json']),
      );
      final reportEntry = archive.files.singleWhere(
        (entry) => entry.name == 'diagnostic-report.json',
      );
      final reportJson = utf8.decode(reportEntry.content as List<int>);
      expect(reportJson, contains('"meetingContentIncluded": false'));
      expect(reportJson, isNot(contains('content://')));
      expect(reportJson, isNot(contains('/data/')));

      final receipt = await shareService.share(built);

      expect(receipt.readOnly, isTrue);
      expect(observed?.method, 'shareEphemeralArtifact');

      messenger.setMockMethodCallHandler(channel, (_) async {
        throw PlatformException(code: 'chooser_failed');
      });
      await expectLater(shareService.share(built), throwsStateError);
      expect(await File(built.artifact.path).exists(), isFalse);
    },
  );
}

Future<void> _insertJob(
  Database database, {
  required int recordingId,
  required String status,
  required String stage,
  required String? errorCode,
  required int startedAtMs,
  required int completedAtMs,
}) async {
  await database.insert('transcription_jobs', <String, Object?>{
    'recording_path': '/data/user/0/private/secret-meeting.m4a',
    'recording_id': recordingId,
    'duration_ms': 1000,
    'status': status,
    'stage': stage,
    'source': 'standard_offline',
    'created_at_ms': 1,
    'updated_at_ms': 1,
    'started_at_ms': startedAtMs,
    'completed_at_ms': completedAtMs,
    'error_code': errorCode,
    'result_text': '敏感转写正文',
    'error_message': 'content://private/error',
  });
}

DiagnosticReport _report() {
  return const DiagnosticReport(
    generatedAtMs: 2000,
    build: DiagnosticBuildInfo(
      packageName: 'com.voice2text.app',
      versionName: '1.0.0',
    ),
    deviceProtection: DiagnosticDeviceProtection(
      storageScope: 'app_private_internal',
      protectionCategory: 'device_security_managed',
      protectionSummary: '由设备安全设置保护',
      applicationLayerEncryption: false,
      platformEncryptionStatus: 'not_exposed',
      backupPolicy: 'app_data_excluded',
    ),
    transcription: DiagnosticTranscriptionSummary(
      statusCounts: <String, int>{'completed': 1},
      stageCounts: <String, int>{'completed': 1},
      errorCategoryCounts: <String, int>{},
      timedJobCount: 1,
      averageProcessingMs: 500,
      maximumProcessingMs: 500,
    ),
  );
}
