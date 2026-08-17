import '../model/audio_intelligence_job_entity.dart';
import '../repository/audio_intelligence_jobs_repository.dart';

class AudioIntelligenceReconcileResult {
  const AudioIntelligenceReconcileResult({
    required this.requeuedJobIds,
    required this.recoveryUnknownJobIds,
  });

  final List<int> requeuedJobIds;
  final List<int> recoveryUnknownJobIds;
}

class AudioIntelligenceJobReconciler {
  AudioIntelligenceJobReconciler({AudioIntelligenceJobsRepository? repository})
    : _repository = repository ?? AudioIntelligenceJobsRepository();

  final AudioIntelligenceJobsRepository _repository;

  Future<AudioIntelligenceReconcileResult> reconcileAfterRestart() async {
    final jobs = await _repository.listUnfinished();
    final requeued = <int>[];
    final unknown = <int>[];
    for (final job in jobs) {
      switch (job.status) {
        case AudioIntelligenceJobStatus.queued:
          await _repository.reconcileQueued(job.id);
          requeued.add(job.id);
        case AudioIntelligenceJobStatus.processing:
          await _repository.markRecoveryUnknown(job.id);
          unknown.add(job.id);
        case AudioIntelligenceJobStatus.completed:
        case AudioIntelligenceJobStatus.failed:
        case AudioIntelligenceJobStatus.canceled:
        case AudioIntelligenceJobStatus.recoveryUnknown:
          break;
      }
    }
    return AudioIntelligenceReconcileResult(
      requeuedJobIds: List<int>.unmodifiable(requeued),
      recoveryUnknownJobIds: List<int>.unmodifiable(unknown),
    );
  }
}
