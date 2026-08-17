import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_models.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_port.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('capture-test');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
  });

  test(
    'preflight keeps caption availability separate from recording',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'preflight');
        return <String, Object?>{
          'minimumMacosVersion': '13.0',
          'systemAudioMinimumMacosVersion': '14.2',
          'captureMode': 'microphone_only',
          'systemAudioPermission': 'granted',
          'microphonePermission': 'granted',
          'microphones': <Object?>[
            <String, Object?>{
              'id': 'builtin',
              'name': 'Built-in Microphone',
              'isDefault': true,
            },
          ],
          'availableBytes': 4 * 1024 * 1024 * 1024,
          'requiredBytes': 1024 * 1024 * 1024,
          'captionModelAvailable': false,
          'canStart': true,
          'blockingReasons': <String>[],
        };
      });

      final preflight = await MacosDesktopCapturePort(channel: channel)
          .preflight(
            sessionRoot: '/private/capture',
            minimumFreeBytes: 1024,
            captionModelAvailable: false,
          );

      expect(preflight.canStart, isTrue);
      expect(preflight.captureMode, DesktopCaptureMode.microphoneOnly);
      expect(preflight.systemAudioMinimumMacosVersion, '14.2');
      expect(preflight.captionModelAvailable, isFalse);
      expect(preflight.microphones.single.id, 'builtin');
    },
  );

  test('snapshot parses partial capture without claiming completed', () {
    final snapshot = DesktopCaptureSessionSnapshot.fromMap(<Object?, Object?>{
      'sessionId': 'session-123456789abc',
      'state': 'partial_capture',
      'captureTimelineMs': 4500,
      'systemAudioHealthy': true,
      'microphoneHealthy': false,
      'partialCapture': true,
      'finalizedChunkCount': 2,
      'eventCount': 1,
    });

    expect(snapshot.state, DesktopCaptureSessionState.partialCapture);
    expect(snapshot.partialCapture, isTrue);
    expect(snapshot.systemAudioHealthy, isTrue);
    expect(snapshot.microphoneHealthy, isFalse);
  });

  test('snapshot preserves an intentional microphone-only mode', () {
    final snapshot = DesktopCaptureSessionSnapshot.fromMap(<Object?, Object?>{
      'sessionId': 'session-123456789abc',
      'state': 'recording',
      'captureMode': 'microphone_only',
      'captureTimelineMs': 4500,
      'systemAudioHealthy': false,
      'microphoneHealthy': true,
      'partialCapture': false,
      'finalizedChunkCount': 1,
      'eventCount': 0,
    });

    expect(snapshot.captureMode, DesktopCaptureMode.microphoneOnly);
    expect(snapshot.partialCapture, isFalse);
    expect(snapshot.systemAudioHealthy, isFalse);
    expect(snapshot.microphoneHealthy, isTrue);
  });

  test('invalid native state fails closed', () {
    expect(
      () => DesktopCaptureSessionSnapshot.fromMap(<Object?, Object?>{
        'sessionId': 'session-123456789abc',
        'state': 'success-ish',
        'captureTimelineMs': 0,
        'systemAudioHealthy': false,
        'microphoneHealthy': false,
        'partialCapture': false,
        'finalizedChunkCount': 0,
        'eventCount': 0,
      }),
      throwsFormatException,
    );
  });

  test(
    'platform errors remain typed and do not become fake snapshots',
    () async {
      messenger.setMockMethodCallHandler(
        channel,
        (call) => throw PlatformException(
          code: 'CAPTURE_PERMISSION_DENIED',
          message: 'System audio permission denied',
          details: <String, Object?>{'nativeError': 'start(1852797029)'},
        ),
      );

      final future = MacosDesktopCapturePort(channel: channel).start(
        const DesktopCaptureStartRequest(
          sessionId: 'session-123456789abc',
          sessionRoot: '/private/capture/session-123456789abc',
          idempotencyKey: 'start-123456789abc',
          minimumFreeBytes: 1024,
        ),
      );
      await expectLater(
        future,
        throwsA(
          isA<DesktopCaptureFailure>()
              .having(
                (failure) => failure.code,
                'code',
                'CAPTURE_PERMISSION_DENIED',
              )
              .having(
                (failure) => failure.details,
                'details',
                <String, Object?>{'nativeError': 'start(1852797029)'},
              ),
        ),
      );
    },
  );
}
