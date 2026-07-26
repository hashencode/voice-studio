import 'dart:io';

enum DesktopDiskEncryptionStatus { enabled, disabled, unknown }

abstract interface class DesktopDiskEncryptionPort {
  Future<DesktopDiskEncryptionStatus> status();
}

class MacosFileVaultStatusPort implements DesktopDiskEncryptionPort {
  const MacosFileVaultStatusPort();

  @override
  Future<DesktopDiskEncryptionStatus> status() async {
    if (!Platform.isMacOS) return DesktopDiskEncryptionStatus.unknown;
    try {
      final result = await Process.run('/usr/bin/fdesetup', const <String>[
        'status',
      ]);
      final output = '${result.stdout}\n${result.stderr}'.toLowerCase();
      if (result.exitCode == 0 && output.contains('filevault is on')) {
        return DesktopDiskEncryptionStatus.enabled;
      }
      if (output.contains('filevault is off')) {
        return DesktopDiskEncryptionStatus.disabled;
      }
    } on ProcessException {
      // A managed host may deny the status probe.
    }
    return DesktopDiskEncryptionStatus.unknown;
  }
}
