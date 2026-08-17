import '../../transcription/model/transcript_segment_entity.dart';
import '../model/audio_intelligence_job_entity.dart';
import '../repository/audio_intelligence_jobs_repository.dart';
import '../repository/audio_intelligence_repository.dart';
import 'audio_intelligence_provider.dart';
import 'audio_intelligence_validator.dart';
import 'transcript_batch_planner.dart';

class AudioIntelligenceGenerationResult {
  const AudioIntelligenceGenerationResult({
    required this.job,
    required this.bundle,
  });

  final AudioIntelligenceJobEntity job;
  final AudioIntelligenceBundle? bundle;
}

class AudioIntelligenceJobCoordinator {
  AudioIntelligenceJobCoordinator({
    AudioIntelligenceJobsRepository? jobsRepository,
    AudioIntelligenceRepository? intelligenceRepository,
    this.planner = const TranscriptBatchPlanner(),
    this.validator = const AudioIntelligenceValidator(),
  }) : _jobsRepository = jobsRepository ?? AudioIntelligenceJobsRepository(),
       _intelligenceRepository =
           intelligenceRepository ?? AudioIntelligenceRepository();

  final AudioIntelligenceJobsRepository _jobsRepository;
  final AudioIntelligenceRepository _intelligenceRepository;
  final TranscriptBatchPlanner planner;
  final AudioIntelligenceValidator validator;

  Future<AudioIntelligenceGenerationResult> generate({
    required AudioIntelligenceProvider provider,
    required AudioIntelligenceRequest request,
    AudioIntelligenceCancellationToken? cancellationToken,
    bool userConfirmedRetry = false,
  }) async {
    final plan = planner.plan(request.segments);
    var job = await _jobsRepository.createOrGet(
      provider: provider,
      request: request,
      estimatedRequestCount: plan.estimatedRequestCount,
      payloadSummary: plan.payloadSummary,
    );
    if (job.status == AudioIntelligenceJobStatus.completed) {
      return AudioIntelligenceGenerationResult(
        job: job,
        bundle: await _intelligenceRepository.findByJobId(job.id),
      );
    }
    if (job.status == AudioIntelligenceJobStatus.processing) {
      throw StateError('同一音频智能任务正在处理中');
    }
    if (job.status == AudioIntelligenceJobStatus.canceled) {
      throw StateError('已取消的音频智能任务不能自动重试');
    }
    if (job.status == AudioIntelligenceJobStatus.failed ||
        job.status == AudioIntelligenceJobStatus.recoveryUnknown) {
      if (!userConfirmedRetry) {
        throw StateError('需要用户确认后才能重试此任务');
      }
      await _jobsRepository.requeueForUserRetry(job.id);
      job = (await _jobsRepository.findById(job.id))!;
    }
    if (cancellationToken?.isCanceled == true) {
      await _jobsRepository.requestCancel(job.id);
      return AudioIntelligenceGenerationResult(
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
        final output = await AudioIntelligenceProviderBoundary(
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
          final output = await AudioIntelligenceProviderBoundary(
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
      return AudioIntelligenceGenerationResult(
        job: (await _jobsRepository.findById(job.id))!,
        bundle: bundle,
      );
    } on AudioIntelligenceProviderException catch (error) {
      if (error.code == AudioIntelligenceFailureCode.canceled) {
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

  AudioIntelligenceRequest _batchRequest(
    AudioIntelligenceRequest source,
    List<TranscriptSegmentEntity> batch,
  ) {
    final startMs = batch
        .map((segment) => segment.startMs)
        .reduce((left, right) => left < right ? left : right);
    final endMs = batch
        .map((segment) => segment.endMs)
        .reduce((left, right) => left > right ? left : right);
    return AudioIntelligenceRequest(
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

  AudioIntelligenceRequest _reductionRequest(
    AudioIntelligenceRequest source,
    List<_ValidatedChunk> chunks,
  ) {
    final candidates = chunks
        .expand((chunk) => chunk.validated.items)
        .where((item) => !item.unsupported)
        .map((item) => item.candidate)
        .toList(growable: false);
    if (candidates.isEmpty) {
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.responseInvalid,
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
      throw const AudioIntelligenceProviderException(
        AudioIntelligenceFailureCode.responseInvalid,
        '分批结果的证据范围无效',
      );
    }
    final startMs = allowedSegments
        .map((segment) => segment.startMs)
        .reduce((left, right) => left < right ? left : right);
    final endMs = allowedSegments
        .map((segment) => segment.endMs)
        .reduce((left, right) => left > right ? left : right);
    return AudioIntelligenceRequest(
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

  final AudioIntelligenceRequest request;
  final ValidatedAudioIntelligence validated;
}
