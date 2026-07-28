import 'package:processing_contracts/processing_contracts.dart';

import 'desktop_job.dart';
import 'desktop_processing_repository.dart';

class DesktopProcessingResult {
  const DesktopProcessingResult({
    required this.segments,
    required this.engineId,
    required this.elapsedMilliseconds,
    required this.peakResidentBytes,
    required this.diarizationSucceeded,
    this.transcriptComplete = true,
    this.diarizationErrorCode,
  });

  final List<ProcessingTranscriptSegment> segments;
  final String engineId;
  final int elapsedMilliseconds;
  final int peakResidentBytes;
  final bool diarizationSucceeded;
  final bool transcriptComplete;
  final String? diarizationErrorCode;
}

abstract interface class DesktopProcessingEngine {
  bool get isAvailable;

  String get availabilityMessage;

  Future<DesktopProcessingResult> process(
    DesktopProcessingJob job, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  });
}

class UnavailableDesktopProcessingEngine implements DesktopProcessingEngine {
  const UnavailableDesktopProcessingEngine({
    required this.nativeRuntimeLoaded,
    this.minimumMacosVersionRequired,
  });

  final bool nativeRuntimeLoaded;
  final String? minimumMacosVersionRequired;

  @override
  bool get isAvailable => false;

  @override
  String get availabilityMessage => minimumMacosVersionRequired != null
      ? '当前系统可使用会议资料库，但本地离线转写需要 macOS '
            '$minimumMacosVersionRequired 或更高版本。'
      : nativeRuntimeLoaded
      ? '本机运行库已就绪，但尚未安装通过 macOS 准入的模型；任务会安全保留。'
      : '本机处理运行库不可用；任务会安全保留，不会生成模拟转写。';

  @override
  Future<DesktopProcessingResult> process(
    DesktopProcessingJob job, {
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) {
    throw StateError('No admitted desktop processing engine is installed.');
  }
}

class DesktopProcessingCoordinator {
  DesktopProcessingCoordinator({
    required DesktopProcessingRepository repository,
    required DesktopProcessingEngine engine,
  }) : _repository = repository,
       _engine = engine;

  final DesktopProcessingRepository _repository;
  DesktopProcessingEngine _engine;

  bool get isAvailable => _engine.isAvailable;

  String get availabilityMessage => _engine.availabilityMessage;

  void replaceEngine(DesktopProcessingEngine engine) {
    if (_activeCancellation != null) {
      throw StateError('cannot replace the engine while a job is active');
    }
    _engine = engine;
  }

  ProcessingCancellationToken? _activeCancellation;

  Future<bool> processNext() async {
    if (!_engine.isAvailable) return false;
    final job = await _repository.claimNext();
    if (job == null) return false;
    final cancellation = ProcessingCancellationToken();
    _activeCancellation = cancellation;
    try {
      final result = await _engine.process(
        job,
        cancellationToken: cancellation,
        onProgress: (progress) {
          _repository.updateProgress(
            job.id,
            phase: progress.phase,
            progress: progress.fraction,
          );
        },
      );
      await _repository.completeWithResult(job, result);
      return true;
    } on ProcessingCancelled {
      await _repository.markCanceled(job.id);
      return false;
    } on ProcessingTimedOut {
      await _repository.markFailed(
        job.id,
        code: 'PROCESSING_TIMEOUT',
        message: '本机处理超过安全时限，可重试',
        retryable: true,
      );
      return false;
    } catch (error) {
      await _repository.markFailed(
        job.id,
        code: 'PROCESSING_ENGINE_FAILED',
        message: '本机处理失败：${error.runtimeType}',
        retryable: true,
      );
      return false;
    } finally {
      if (identical(_activeCancellation, cancellation)) {
        _activeCancellation = null;
      }
    }
  }

  Future<void> cancelActive() async {
    final cancellation = _activeCancellation;
    if (cancellation == null) return;
    cancellation.cancel();
    await _repository.markCanceling();
  }
}
