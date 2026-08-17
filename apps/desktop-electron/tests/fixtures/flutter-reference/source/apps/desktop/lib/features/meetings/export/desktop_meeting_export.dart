import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;

abstract interface class DesktopMeetingExportPort {
  Future<String?> save({
    required String suggestedName,
    required MeetingWorkspaceExport export,
  });
}

class FileSelectorDesktopMeetingExportPort implements DesktopMeetingExportPort {
  const FileSelectorDesktopMeetingExportPort();

  @override
  Future<String?> save({
    required String suggestedName,
    required MeetingWorkspaceExport export,
  }) async {
    final safeBase = suggestedName
        .replaceAll(RegExp(r'[/\\:\u0000-\u001f]'), '_')
        .trim();
    final location = await getSaveLocation(
      suggestedName:
          '${safeBase.isEmpty ? 'meeting' : safeBase}.${export.fileExtension}',
      acceptedTypeGroups: <XTypeGroup>[
        XTypeGroup(
          label: export.format.name,
          extensions: <String>[export.fileExtension],
          mimeTypes: <String>[export.mimeType],
        ),
      ],
    );
    if (location == null) return null;
    final destination = File(p.normalize(location.path));
    await destination.writeAsString(export.contents, flush: true);
    return destination.path;
  }
}
