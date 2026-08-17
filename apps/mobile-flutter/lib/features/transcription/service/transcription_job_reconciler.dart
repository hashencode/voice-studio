import '../repository/transcription_jobs_repository.dart';

class TranscriptionJobReconciler {
  TranscriptionJobReconciler({
    required TranscriptionJobsRepository repository,
    DateTime Function()? clock,
    int Function()? nowMs,
    this.staleAfter = const Duration(minutes: 2),
  }) : _repository = repository,
       _nowMs =
           nowMs ?? (() => (clock ?? DateTime.now)().millisecondsSinceEpoch);

  final TranscriptionJobsRepository _repository;
  final int Function() _nowMs;
  final Duration staleAfter;

  Future<int> reconcile() {
    return _repository.requeueStaleProcessing(
      staleBeforeMs: _nowMs() - staleAfter.inMilliseconds,
    );
  }

  Future<int> reconcileInterrupted({required Set<int> activeNativeJobIds}) {
    return _repository.requeueInterruptedProcessing(
      activeNativeJobIds: activeNativeJobIds,
    );
  }
}
