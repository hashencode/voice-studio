import '../model/audio_insight_entity.dart';
import '../repository/audio_intelligence_repository.dart';
import 'audio_intelligence_provider.dart';
import 'audio_intelligence_validator.dart';

class AudioIntelligenceReviewService {
  AudioIntelligenceReviewService({
    AudioIntelligenceRepository? repository,
    AudioIntelligenceValidator? validator,
  }) : _repository = repository ?? AudioIntelligenceRepository(),
       _validator = validator ?? const AudioIntelligenceValidator();

  final AudioIntelligenceRepository _repository;
  final AudioIntelligenceValidator _validator;

  Future<AudioIntelligenceBundle> generateDraft({
    required AudioIntelligenceProviderBoundary boundary,
    required AudioIntelligenceRequest request,
  }) async {
    final provider = boundary.provider;
    if (provider == null) {
      throw StateError('未配置音频智能提供商');
    }
    final output = await boundary.generate(request);
    final validated = _validator.validate(request: request, output: output);
    return _repository.createDraft(
      provider: provider,
      request: request,
      validated: validated,
    );
  }

  Future<void> edit({
    required int insightId,
    required String body,
    String? actionOwner,
    int? actionDueAtMs,
    bool clearActionOwner = false,
    bool clearActionDueAt = false,
  }) async {
    await _requireInsight(insightId);
    await _repository.editInsight(
      insightId: insightId,
      body: body,
      actionOwner: actionOwner,
      actionDueAtMs: actionDueAtMs,
      clearActionOwner: clearActionOwner,
      clearActionDueAt: clearActionDueAt,
    );
  }

  Future<void> markReviewed(int insightId) async {
    final insight = await _requireInsight(insightId);
    if (insight.status != AudioInsightStatus.draft) {
      throw StateError('只有草稿可以标记为已审核');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: AudioInsightStatus.reviewed,
      action: 'review',
    );
  }

  Future<void> reject(int insightId) async {
    final insight = await _requireInsight(insightId);
    if (insight.status != AudioInsightStatus.draft &&
        insight.status != AudioInsightStatus.reviewed) {
      throw StateError('当前状态不可驳回');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: AudioInsightStatus.rejected,
      action: 'reject',
    );
  }

  Future<void> publish(int insightId) async {
    final insight = await _requireInsight(insightId);
    if (insight.status != AudioInsightStatus.reviewed) {
      throw StateError('条目必须先完成审核');
    }
    if (insight.unsupported ||
        await _repository.evidenceCount(insightId) == 0) {
      throw StateError('缺少可播放证据的条目不可发布');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: AudioInsightStatus.published,
      action: 'publish',
    );
  }

  Future<void> setResolved(int insightId, {required bool resolved}) async {
    await _requireInsight(insightId);
    await _repository.updateResolutionState(
      insightId: insightId,
      state: resolved
          ? AudioInsightResolutionState.resolved
          : AudioInsightResolutionState.open,
    );
  }

  Future<void> applySuggestedTitle({
    required int noteId,
    required String title,
  }) {
    return _repository.applySuggestedTitle(noteId: noteId, title: title);
  }

  Future<AudioInsightEntity> _requireInsight(int insightId) async {
    final insight = await _repository.findInsight(insightId);
    if (insight == null) throw StateError('音频智能条目不存在');
    return insight;
  }
}
