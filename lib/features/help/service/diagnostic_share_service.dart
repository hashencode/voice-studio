import 'dart:convert';
import 'dart:io';

import '../../shared/service/ephemeral_share_artifact_service.dart';
import '../model/diagnostic_report.dart';

class DiagnosticShareArtifact {
  const DiagnosticShareArtifact({required this.artifact, required this.report});

  final EphemeralShareArtifact artifact;
  final DiagnosticReport report;
}

class DiagnosticShareService {
  DiagnosticShareService({EphemeralShareArtifactService? artifactService})
    : _artifactService = artifactService ?? EphemeralShareArtifactService();

  final EphemeralShareArtifactService _artifactService;

  Future<DiagnosticShareArtifact> build(DiagnosticReport report) async {
    await _artifactService.cleanupStale();
    final result = await _artifactService.buildZip(
      baseName: 'voice2text-diagnostics',
      entries: <EphemeralArchiveEntry>[
        EphemeralArchiveEntry(
          id: 'diagnostic-report',
          name: 'diagnostic-report.json',
          write: (File target) =>
              target.writeAsString(report.toPrettyJson(), flush: true),
        ),
      ],
      buildManifest: (entries) =>
          const JsonEncoder.withIndent('  ').convert(<String, Object?>{
            'schemaVersion': 1,
            'contents': <String>['diagnostic-report.json'],
            'retentionHours': 24,
            'readOnlyShare': true,
            'meetingDataIncluded': false,
            'rawLogsIncluded': false,
          }),
    );
    final artifact = result.artifact;
    if (artifact == null) {
      throw StateError('安全诊断包未生成');
    }
    return DiagnosticShareArtifact(artifact: artifact, report: report);
  }

  Future<EphemeralShareReceipt> share(DiagnosticShareArtifact artifact) {
    return _artifactService.share(artifact.artifact);
  }

  Future<bool> discard(DiagnosticShareArtifact artifact) {
    return _artifactService.discard(artifact.artifact.path);
  }
}
