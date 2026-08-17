import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_intelligence_job_entity.dart';
import 'package:voice2text_flutter/features/audio_intelligence/model/audio_template.dart';
import 'package:voice2text_flutter/features/audio_intelligence/repository/audio_intelligence_jobs_repository.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/fixture_audio_intelligence_provider.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_job_reconciler.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_intelligence_provider.dart';

import 'audio_intelligence_test_fixture.dart';

void main() {
  test(
    'restart requeues pre-request work and isolates in-flight cost uncertainty',
    () async {
      final fixture = await createAudioIntelligenceFixture();
      addTearDown(fixture.database.close);
      final repository = AudioIntelligenceJobsRepository(
        database: fixture.appDatabase,
      );
      final provider = FixtureAudioIntelligenceProvider(
        output: const AudioIntelligenceOutput(items: <AudioInsightCandidate>[]),
      );
      final queued = await repository.createOrGet(
        provider: provider,
        request: _request(fixture.request, AudioTemplateId.weekly),
        estimatedRequestCount: 1,
        payloadSummary: 'queued',
      );
      final processing = await repository.createOrGet(
        provider: provider,
        request: _request(fixture.request, AudioTemplateId.review),
        estimatedRequestCount: 1,
        payloadSummary: 'processing',
      );
      await repository.markProcessing(processing.id);

      final result = await AudioIntelligenceJobReconciler(
        repository: repository,
      ).reconcileAfterRestart();

      expect(result.requeuedJobIds, <int>[queued.id]);
      expect(result.recoveryUnknownJobIds, <int>[processing.id]);
      expect(
        (await repository.findById(queued.id))!.status,
        AudioIntelligenceJobStatus.queued,
      );
      expect(
        (await repository.findById(processing.id))!.status,
        AudioIntelligenceJobStatus.recoveryUnknown,
      );
      expect(() => repository.markProcessing(processing.id), throwsStateError);
    },
  );
}

AudioIntelligenceRequest _request(
  AudioIntelligenceRequest source,
  AudioTemplateId template,
) {
  return AudioIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: AudioProcessingLocation.cloudDirect,
    consentDecision: AudioConsentDecision.granted,
    inputStartMs: source.inputStartMs,
    inputEndMs: source.inputEndMs,
    segments: source.segments,
    templateId: template,
    consentAtMs: 123,
    payloadSummary: 'fixture',
  );
}
