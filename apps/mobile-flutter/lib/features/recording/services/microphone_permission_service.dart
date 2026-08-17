import 'package:permission_handler/permission_handler.dart';

class MicrophonePermissionService {
  Future<bool> ensurePermissionGranted() async {
    final PermissionStatus status = await Permission.microphone.request();
    return status.isGranted;
  }
}
