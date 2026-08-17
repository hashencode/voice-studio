import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_intelligence_job_entity.dart';
import '../repository/meeting_intelligence_jobs_repository.dart';
import '../repository/meeting_intelligence_repository.dart';
import 'meeting_intelligence_provider.dart';
import 'meeting_intelligence_validator.dart';
import 'transcript_batch_planner.dart';

class MeetingIntelligenceGenerationResult {
  const MeetingIntelligenceGenerationResult({
    required this.job,
    required this.bundle,
  });

  final MeetingIntelligenceJobEntity job;
  final MeetingIntelligenceBundle? bundle;
}

class MeetingIntelligenceJobCoordinator {
  MeetingIntelligenceJobCoordinator({
    MeetingIntelligenceJobsRepository? jobsRepository,
    MeetingIntelligenceRepository? intelligenceRepository,
    this.planner = const TranscriptBatchPlanner(),
    this.validator = const MeetingIntelligenceValidator(),
  }) : _jobsRepository = jobsRepository ?? MeetingIntelligenceJobsRepository(),
       _intelligenceRepository =
           intelligenceRepository ?? MeetingIntelligenceRepository();

  final MeetingIntelligenceJobsRepository _jobsRepository;
  final MeetingIntelligenceRepository _intelligenceRepository;
  final TranscriptBatchPlanner planner;
  final MeetingIntelligenceValidator validator;

  Future<MeetingIntelligenceGenerationResult> generate({
    required MeetingIntelligenceProvider provider,
    required MeetingIntelligenceRequest request,
    MeetingIntelligenceCancellationToken? cancellationToken,
    bool userConfirmedRetry = false,
  }) async {
    final plan = planner.plan(request.segments);
    var job = await _jobsRepository.createOrGet(
      provider: provider,
      request: request,
      estimatedRequestCount: plan.estimatedRequestCount,
      payloadSummary: plan.payloadSummary,
    );
    if (job.status == MeetingIntelligenceJobStatus.completed) {
      return MeetingIntelligenceGenerationResult(
        job: job,
        bundle: await _intelligenceRepository.findByJobId(job.id),
      );
    }
    if (job.status == MeetingIntelligenceJobStatus.processing) {
      throw StateError('同一会议智能任务正在处理中');
    }
    if (job.status == MeetingIntelligenceJobStatus.canceled) {
      throw StateError('已取消的会议智能任务不能自动重试');
    }
    if (job.status == MeetingIntelligenceJobStatus.failed ||
        job.status == MeetingIntelligenceJobStatus.recoveryUnknown) {
      if (!userConfirmedRetry) {
        throw StateError('需要用户确认后才能重试此任务');
      }
      await _jobsRepository.requeueForUserRetry(job.id);
      job = (await _jobsRepository.findById(job.id))!;
    }
    if (cancellationToken?.isCanceled == true) {
      await _jobsRepository.requestCancel(job.id);
      return MeetingIntelligenceGenerationResult(
        job: (await _jobsRepository.findById(job.id))!,
        bundle: null,
      );
    }
    await _jobsRepository.markProcessing(job.id);
    var completedRequests = 0;
    try {
      final chunks = <_ValidatedChunk>[];
      for (final batch in plan.batches) {
        cancellationToken?.throwIfCanceled();
        final batchRequest = _batchRequest(request, batch);
        final output = await MeetingIntelligenceProviderBoundary(
          provider: provider,
          localOnly: false,
        ).generate(batchRequest, cancellationToken: cancellationToken);
        chunks.add(
          _ValidatedChunk(
            request: batchRequest,
            validated: validator.validate(
              request: batchRequest,
              output: output,
            ),
          ),
        );
        completedRequests += 1;
        await _jobsRepository.updateProgress(
          job.id,
          completedRequests / plan.estimatedRequestCount,
        );
      }

      var current = chunks;
      while (current.length > 1) {
        final next = <_ValidatedChunk>[];
        for (final group in planner.reductionGroups(current)) {
          cancellationToken?.throwIfCanceled();
          final reductionRequest = _reductionRequest(request, group);
          final output = await MeetingIntelligenceProviderBoundary(
            provider: provider,
            localOnly: false,
          ).generate(reductionRequest, cancellationToken: cancellationToken);
          next.add(
            _ValidatedChunk(
              request: reductionRequest,
              validated: validator.validate(
                request: reductionRequest,
                output: output,
              ),
            ),
          );
          completedRequests += 1;
          await _jobsRepository.updateProgress(
            job.id,
            completedRequests / plan.estimatedRequestCount,
          );
        }
        current = next;
      }

      cancellationToken?.throwIfCanceled();
      final bundle = await _intelligenceRepository.createDraft(
        provider: provider,
        request: request,
        validated: current.single.validated,
        jobId: job.id,
      );
      return MeetingIntelligenceGenerationResult(
        job: (await _jobsRepository.findById(job.id))!,
        bundle: bundle,
      );
    } on MeetingIntelligenceProviderException catch (error) {
      if (error.code == MeetingIntelligenceFailureCode.canceled) {
        await _jobsRepository.markCanceled(job.id);
      } else {
        await _jobsRepository.markFailed(job.id, error.code.name);
      }
      rethrow;
    } on Object {
      await _jobsRepository.markFailed(job.id, 'local_validation_failed');
      rethrow;
    }
  }

  MeetingIntelligenceRequest _batchRequest(
    MeetingIntelligenceRequest source,
    List<TranscriptSegmentEntity> batch,
  ) {
    final startMs = batch
        .map((segment) => segment.startMs)
        .reduce((left, right) => left < right ? left : right);
    final endMs = batch
        .map((segment) => segment.endMs)
        .reduce((left, right) => left > right ? left : right);
    return MeetingIntelligenceRequest(
      recordingId: source.recordingId,
      generationId: source.generationId,
      processingLocation: source.processingLocation,
      consentDecision: source.consentDecision,
      inputStartMs: startMs,
      inputEndMs: endMs,
      segments: batch,
      templateId: source.templateId,
      consentVersion: source.consentVersion,
      consentAtMs: source.consentAtMs,
      payloadSummary: source.payloadSummary,
      estimatedRequestCount: source.estimatedRequestCount,
      speakerLabelsIncluded: source.speakerLabelsIncluded,
    );
  }

  MeetingIntelligenceRequest _reductionRequest(
    MeetingIntelligenceRequest source,
    List<_ValidatedChunk> chunks,
  ) {
    final candidates = chunks
        .expand((chunk) => chunk.validated.items)
        .where((item) => !item.unsupported)
        .map((item) => item.candidate)
        .toList(growable: false);
    if (candidates.isEmpty) {
      throw const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.responseInvalid,
        '分批结果没有可验证证据，无法安全汇总',
      );
    }
    final allowedSegmentIds = candidates
        .expand((candidate) => candidate.evidence)
        .map((evidence) => evidence.segmentId)
        .toSet();
    final allowedSegments = source.segments
        .where((segment) => allowedSegmentIds.contains(segment.id))
        .toList(growable: false);
    if (allowedSegments.isEmpty) {
      throw const MeetingIntelligenceProviderException(
        MeetingIntelligenceFailureCode.responseInvalid,
        '分批结果的证据范围无效',
      );
    }
    final startMs = allowedSegments
        .map((segment) => segment.startMs)
        .reduce((left, right) => left < right ? left : right);
    final endMs = allowedSegments
        .map((segment) => segment.endMs)
        .reduce((left, right) => left > right ? left : right);
    return MeetingIntelligenceRequest(
      recordingId: source.recordingId,
      generationId: source.generationId,
      processingLocation: source.processingLocation,
      consentDecision: source.consentDecision,
      inputStartMs: startMs,
      inputEndMs: endMs,
      segments: allowedSegments,
      templateId: source.templateId,
      consentVersion: source.consentVersion,
      consentAtMs: source.consentAtMs,
      payloadSummary: source.payloadSummary,
      estimatedRequestCount: source.estimatedRequestCount,
      speakerLabelsIncluded: source.speakerLabelsIncluded,
      reductionCandidates: candidates,
    );
  }
}

class _ValidatedChunk {
  const _ValidatedChunk({required this.request, required this.validated});

  final MeetingIntelligenceRequest request;
  final ValidatedMeetingIntelligence validated;
}
