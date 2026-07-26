import '../model/meeting_insight_entity.dart';
import '../repository/meeting_intelligence_repository.dart';
import 'meeting_intelligence_provider.dart';
import 'meeting_intelligence_validator.dart';

class MeetingIntelligenceReviewService {
  MeetingIntelligenceReviewService({
    MeetingIntelligenceRepository? repository,
    MeetingIntelligenceValidator? validator,
  }) : _repository = repository ?? MeetingIntelligenceRepository(),
       _validator = validator ?? const MeetingIntelligenceValidator();

  final MeetingIntelligenceRepository _repository;
  final MeetingIntelligenceValidator _validator;

  Future<MeetingIntelligenceBundle> generateDraft({
    required MeetingIntelligenceProviderBoundary boundary,
    required MeetingIntelligenceRequest request,
  }) async {
    final provider = boundary.provider;
    if (provider == null) {
      throw StateError('未配置会议智能提供商');
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
    if (insight.status != MeetingInsightStatus.draft) {
      throw StateError('只有草稿可以标记为已审核');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: MeetingInsightStatus.reviewed,
      action: 'review',
    );
  }

  Future<void> reject(int insightId) async {
    final insight = await _requireInsight(insightId);
    if (insight.status != MeetingInsightStatus.draft &&
        insight.status != MeetingInsightStatus.reviewed) {
      throw StateError('当前状态不可驳回');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: MeetingInsightStatus.rejected,
      action: 'reject',
    );
  }

  Future<void> publish(int insightId) async {
    final insight = await _requireInsight(insightId);
    if (insight.status != MeetingInsightStatus.reviewed) {
      throw StateError('条目必须先完成审核');
    }
    if (insight.unsupported ||
        await _repository.evidenceCount(insightId) == 0) {
      throw StateError('缺少可播放证据的条目不可发布');
    }
    await _repository.updateInsightStatus(
      insightId: insightId,
      status: MeetingInsightStatus.published,
      action: 'publish',
    );
  }

  Future<void> setResolved(int insightId, {required bool resolved}) async {
    await _requireInsight(insightId);
    await _repository.updateResolutionState(
      insightId: insightId,
      state: resolved
          ? MeetingInsightResolutionState.resolved
          : MeetingInsightResolutionState.open,
    );
  }

  Future<void> applySuggestedTitle({
    required int noteId,
    required String title,
  }) {
    return _repository.applySuggestedTitle(noteId: noteId, title: title);
  }

  Future<MeetingInsightEntity> _requireInsight(int insightId) async {
    final insight = await _repository.findInsight(insightId);
    if (insight == null) throw StateError('会议智能条目不存在');
    return insight;
  }
}
