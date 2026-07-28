import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('native capture lifecycle smoke', (tester) async {
    final support = await getApplicationSupportDirectory();
    final sessionId =
        'session-u11-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    final root = Directory(p.join(support.path, 'capture-probes', sessionId));
    final capture = MacosDesktopCapturePort();
    final preflight = await capture.preflight(
      sessionRoot: root.path,
      minimumFreeBytes: 128 * 1024 * 1024,
      captionModelAvailable: false,
      requestPermissions:
          Platform.environment['VOICE2TEXT_CAPTURE_REQUEST_PERMISSIONS'] ==
          'true',
    );
    expect(
      preflight.canStart,
      isTrue,
      reason: 'Capture preflight blocked: ${preflight.blockingReasons}',
    );

    final source = File(
      p.join(
        Directory.current.parent.parent.path,
        'assets',
        'sherpa',
        'wav',
        'test.wav',
      ),
    );
    Process? player;
    if (source.existsSync()) {
      player = await Process.start('/usr/bin/afplay', <String>[source.path]);
    }
    addTearDown(() async {
      player?.kill();
      if (root.existsSync()) {
        await root.delete(recursive: true);
      }
    });

    final started = await capture.start(
      DesktopCaptureStartRequest(
        sessionId: sessionId,
        sessionRoot: root.path,
        idempotencyKey: 'start-$sessionId',
        minimumFreeBytes: 128 * 1024 * 1024,
      ),
    );
    expect(started.state.wireName, 'recording');
    await tester.pump(const Duration(seconds: 2));

    final paused = await capture.pause(
      sessionId: sessionId,
      idempotencyKey: 'pause-$sessionId',
    );
    expect(paused.state.wireName, 'paused');
    await tester.pump(const Duration(milliseconds: 300));

    final resumed = await capture.resume(
      sessionId: sessionId,
      idempotencyKey: 'resume-$sessionId',
    );
    expect(resumed.state.wireName, 'recording');
    await tester.pump(const Duration(seconds: 2));

    final stopped = await capture.stop(
      sessionId: sessionId,
      idempotencyKey: 'stop-$sessionId',
    );
    final repeated = await capture.stop(
      sessionId: sessionId,
      idempotencyKey: 'stop-$sessionId',
    );
    expect(stopped.state.wireName, 'completed');
    expect(repeated.captureTimelineMs, stopped.captureTimelineMs);
  });
}
