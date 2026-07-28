import 'package:flutter/material.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_controller.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_view_model.dart';

class FakeCaptureUiController extends ChangeNotifier
    implements DesktopCaptureUiController {
  FakeCaptureUiController(this.value);

  @override
  DesktopCaptureViewModel value;

  int preflightCalls = 0;
  int permissionPreflightCalls = 0;
  int startCalls = 0;
  int pauseCalls = 0;
  int resumeCalls = 0;
  int stopCalls = 0;
  int resetCalls = 0;
  final List<String> keptSessions = <String>[];
  final List<String> discardedSessions = <String>[];

  void replace(DesktopCaptureViewModel next) {
    value = next;
    notifyListeners();
  }

  @override
  Future<void> preflight({bool requestPermissions = false}) async {
    preflightCalls += 1;
    if (requestPermissions) permissionPreflightCalls += 1;
  }

  @override
  void selectMicrophone(String deviceId) {
    value = value.copyWith(selectedMicrophoneId: deviceId);
    notifyListeners();
  }

  @override
  void setCaptionEnabled(bool enabled) {
    value = value.copyWith(captionEnabled: enabled);
    notifyListeners();
  }

  @override
  Future<void> start() async {
    startCalls += 1;
  }

  @override
  Future<void> pause() async {
    pauseCalls += 1;
  }

  @override
  Future<void> resume() async {
    resumeCalls += 1;
  }

  @override
  Future<void> restartCaptions() async {}

  @override
  Future<MeetingHandoffOutcome?> stop({String displayName = '电脑会议'}) async {
    stopCalls += 1;
    return null;
  }

  @override
  Future<void> keepRecovered(String sessionId) async {
    keptSessions.add(sessionId);
  }

  @override
  Future<void> discardRecovered(String sessionId) async {
    discardedSessions.add(sessionId);
  }

  @override
  void reset() {
    resetCalls += 1;
  }
}

Widget captureTestApp({
  required FakeCaptureUiController controller,
  required Widget Function(DesktopCaptureViewModel model) builder,
}) {
  return MaterialApp(
    home: Scaffold(
      body: AnimatedBuilder(
        animation: controller,
        builder: (_, _) => builder(controller.value),
      ),
    ),
  );
}
