import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_recovery.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_service.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_workspace.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  testWidgets('native capture faults remain durable and idempotent', (
    tester,
  ) async {
    final support = await getApplicationSupportDirectory();
    final runId = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final runRoot = Directory(
      p.join(support.path, 'capture-recovery-tests', runId),
    );
    final workspace = DesktopCaptureWorkspace(
      Directory(p.join(runRoot.path, 'sessions')),
    );
    final database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => runRoot.path,
      databaseName: 'capture.db',
    );
    final repository = DesktopCaptureRepository(database);
    final port = MacosDesktopCapturePort();
    final service = DesktopCaptureService(
      port: port,
      repository: repository,
      workspace: workspace,
      recovery: DesktopCaptureRecovery(
        repository: repository,
        workspace: workspace,
      ),
    );
    addTearDown(() async {
      await (await database.database).close();
      if (await runRoot.exists()) {
        await runRoot.delete(recursive: true);
      }
    });

    final preflight = await service.preflight(
      minimumFreeBytes: 128 * 1024 * 1024,
      captionModelAvailable: false,
      requestPermissions: true,
    );
    expect(preflight.canStart, isTrue, reason: '${preflight.blockingReasons}');

    final normal = await _start(service, runId, 'normal');
    await tester.pump(const Duration(seconds: 1));
    final completed = await service.stop(
      sessionId: normal,
      idempotencyKey: 'stop-$normal',
      displayName: 'Normal native capture',
    );
    final repeated = await service.stop(
      sessionId: normal,
      idempotencyKey: 'stop-$normal',
      displayName: 'Normal native capture',
    );
    expect(completed.state, DesktopCaptureSessionState.completed);
    expect(repeated.recordingId, completed.recordingId);

    final microphoneFault = await _start(service, runId, 'microphone');
    await tester.pump(const Duration(seconds: 1));
    final microphonePartial = await _inject(
      microphoneFault,
      'microphone_disconnect',
    );
    expect(microphonePartial.partialCapture, isTrue);
    expect(microphonePartial.systemAudioHealthy, isTrue);
    expect(microphonePartial.microphoneHealthy, isFalse);
    expect(microphonePartial.eventCount, greaterThanOrEqualTo(1));
    final partialCommit = await service.stop(
      sessionId: microphoneFault,
      idempotencyKey: 'stop-$microphoneFault',
      displayName: 'Partial native capture',
    );
    expect(partialCommit.state, DesktopCaptureSessionState.partialCapture);
    expect(partialCommit.recordingId, isNotNull);

    final diskFault = await _start(service, runId, 'disk');
    await tester.pump(const Duration(seconds: 1));
    final diskPartial = await _inject(diskFault, 'disk_low');
    expect(diskPartial.partialCapture, isTrue);
    expect(diskPartial.systemAudioHealthy, isFalse);
    expect(diskPartial.microphoneHealthy, isFalse);
    expect(diskPartial.eventCount, greaterThanOrEqualTo(1));
    final diskCommit = await service.stop(
      sessionId: diskFault,
      idempotencyKey: 'stop-$diskFault',
      displayName: 'Low-disk native capture',
    );
    expect(diskCommit.state, DesktopCaptureSessionState.partialCapture);

    final dualFault = await _start(service, runId, 'dual');
    await tester.pump(const Duration(seconds: 1));
    await _inject(dualFault, 'microphone_disconnect');
    final failed = await _inject(dualFault, 'system_encoder_failure');
    expect(failed.state, DesktopCaptureSessionState.failed);
    final recovered = await service.recoverInterrupted();
    final dualRecovery = recovered.singleWhere(
      (value) => value.sessionId == dualFault,
    );
    expect(dualRecovery.state, 'partial_capture');
    expect(dualRecovery.error, isNull);

    final sql = await database.database;
    expect(
      (await sql.rawQuery(
        'SELECT COUNT(*) AS count FROM recordings',
      )).single['count'],
      3,
    );
    final assets = await sql.query(
      'meeting_assets',
      where: "kind LIKE 'capture_%' AND kind != 'capture_manifest'",
    );
    expect(assets.length, greaterThanOrEqualTo(6));
    for (final asset in assets) {
      final file = File(asset['path']! as String);
      expect(await file.exists(), isTrue);
      expect(
        await file
            .openRead(0, 4)
            .fold<List<int>>(<int>[], (bytes, chunk) => bytes..addAll(chunk)),
        <int>[0x63, 0x61, 0x66, 0x66],
      );
    }
  });
}

Future<String> _start(
  DesktopCaptureService service,
  String runId,
  String suffix,
) async {
  final sessionId = 'session-$suffix-$runId';
  final snapshot = await service.start(
    sessionId: sessionId,
    idempotencyKey: 'start-$sessionId',
    minimumFreeBytes: 128 * 1024 * 1024,
  );
  expect(snapshot.state, DesktopCaptureSessionState.recording);
  return sessionId;
}

Future<DesktopCaptureSessionSnapshot> _inject(
  String sessionId,
  String fault,
) async {
  const channel = MethodChannel('com.voice2text.desktop/capture');
  final result = await channel.invokeMapMethod<Object?, Object?>(
    'developmentInjectFault',
    <String, Object?>{'sessionId': sessionId, 'fault': fault},
  );
  return DesktopCaptureSessionSnapshot.fromMap(result!);
}
