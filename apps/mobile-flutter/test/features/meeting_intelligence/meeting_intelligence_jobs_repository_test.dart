import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_intelligence_job_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_jobs_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/fixture_meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test(
    'deduplicates identical input and persists non-secret audit fields',
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
      final request = _cloudRequest(fixture.request);

      final first = await repository.createOrGet(
        provider: provider,
        request: request,
        estimatedRequestCount: 2,
        payloadSummary: 'synthetic payload',
      );
      final second = await repository.createOrGet(
        provider: provider,
        request: request,
        estimatedRequestCount: 2,
        payloadSummary: 'synthetic payload',
      );

      expect(second.id, first.id);
      expect(first.status, MeetingIntelligenceJobStatus.queued);
      expect(first.providerId, provider.providerId);
      expect(first.modelId, provider.modelId);
      expect(first.payloadSummary, 'synthetic payload');
      expect(first.dedupeKey, hasLength(64));
    },
  );

  test(
    'retry is explicit and increments attempt only when request starts',
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
      final job = await repository.createOrGet(
        provider: provider,
        request: _cloudRequest(fixture.request),
        estimatedRequestCount: 1,
        payloadSummary: 'fixture',
      );

      expect((await repository.markProcessing(job.id)).attemptCount, 1);
      await repository.markFailed(job.id, 'rateLimited');
      await repository.requeueForUserRetry(job.id);
      expect((await repository.findById(job.id))!.attemptCount, 1);
      expect((await repository.markProcessing(job.id)).attemptCount, 2);
    },
  );

  test('queued cancel finishes without starting an attempt', () async {
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
    final job = await repository.createOrGet(
      provider: provider,
      request: _cloudRequest(fixture.request),
      estimatedRequestCount: 1,
      payloadSummary: 'fixture',
    );

    await repository.requestCancel(job.id);
    final canceled = (await repository.findById(job.id))!;
    expect(canceled.status, MeetingIntelligenceJobStatus.canceled);
    expect(canceled.attemptCount, 0);
  });

  test('refuses to create cloud job without timestamped consent', () async {
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

    expect(
      () => repository.createOrGet(
        provider: provider,
        request: fixture.request,
        estimatedRequestCount: 1,
        payloadSummary: 'fixture',
      ),
      throwsStateError,
    );
  });
}

MeetingIntelligenceRequest _cloudRequest(MeetingIntelligenceRequest source) {
  return MeetingIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: MeetingProcessingLocation.cloudDirect,
    consentDecision: MeetingConsentDecision.granted,
    inputStartMs: source.inputStartMs,
    inputEndMs: source.inputEndMs,
    segments: source.segments,
    consentAtMs: 123,
    payloadSummary: 'fixture',
  );
}
