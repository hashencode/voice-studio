import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_intelligence_job_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_template.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_jobs_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_job_reconciler.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test(
    'restart requeues pre-request work and isolates in-flight cost uncertainty',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = MeetingIntelligenceJobsRepository(
        database: fixture.appDatabase,
      );
      final provider = FixtureMeetingIntelligenceProvider(
        output: const MeetingIntelligenceOutput(
          items: <MeetingInsightCandidate>[],
        ),
      );
      final queued = await repository.createOrGet(
        provider: provider,
        request: _request(fixture.request, MeetingTemplateId.weekly),
        estimatedRequestCount: 1,
        payloadSummary: 'queued',
      );
      final processing = await repository.createOrGet(
        provider: provider,
        request: _request(fixture.request, MeetingTemplateId.review),
        estimatedRequestCount: 1,
        payloadSummary: 'processing',
      );
      await repository.markProcessing(processing.id);

      final result = await MeetingIntelligenceJobReconciler(
        repository: repository,
      ).reconcileAfterRestart();

      expect(result.requeuedJobIds, <int>[queued.id]);
      expect(result.recoveryUnknownJobIds, <int>[processing.id]);
      expect(
        (await repository.findById(queued.id))!.status,
        MeetingIntelligenceJobStatus.queued,
      );
      expect(
        (await repository.findById(processing.id))!.status,
        MeetingIntelligenceJobStatus.recoveryUnknown,
      );
      expect(() => repository.markProcessing(processing.id), throwsStateError);
    },
  );
}

MeetingIntelligenceRequest _request(
  MeetingIntelligenceRequest source,
  MeetingTemplateId template,
) {
  return MeetingIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: MeetingProcessingLocation.cloudDirect,
    consentDecision: MeetingConsentDecision.granted,
    inputStartMs: source.inputStartMs,
    inputEndMs: source.inputEndMs,
    segments: source.segments,
    templateId: template,
    consentAtMs: 123,
    payloadSummary: 'fixture',
  );
}
