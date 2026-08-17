import '../model/meeting_intelligence_job_entity.dart';
import '../repository/meeting_intelligence_jobs_repository.dart';

class MeetingIntelligenceReconcileResult {
  const MeetingIntelligenceReconcileResult({
    required this.requeuedJobIds,
    required this.recoveryUnknownJobIds,
  });

  final List<int> requeuedJobIds;
  final List<int> recoveryUnknownJobIds;
}

class MeetingIntelligenceJobReconciler {
  MeetingIntelligenceJobReconciler({
    MeetingIntelligenceJobsRepository? repository,
  }) : _repository = repository ?? MeetingIntelligenceJobsRepository();

  final MeetingIntelligenceJobsRepository _repository;

  Future<MeetingIntelligenceReconcileResult> reconcileAfterRestart() async {
    final jobs = await _repository.listUnfinished();
    final requeued = <int>[];
    final unknown = <int>[];
    for (final job in jobs) {
      switch (job.status) {
        case MeetingIntelligenceJobStatus.queued:
          await _repository.reconcileQueued(job.id);
          requeued.add(job.id);
        case MeetingIntelligenceJobStatus.processing:
          await _repository.markRecoveryUnknown(job.id);
          unknown.add(job.id);
        case MeetingIntelligenceJobStatus.completed:
        case MeetingIntelligenceJobStatus.failed:
        case MeetingIntelligenceJobStatus.canceled:
        case MeetingIntelligenceJobStatus.recoveryUnknown:
          break;
      }
    }
    return MeetingIntelligenceReconcileResult(
      requeuedJobIds: List<int>.unmodifiable(requeued),
      recoveryUnknownJobIds: List<int>.unmodifiable(unknown),
    );
  }
}
