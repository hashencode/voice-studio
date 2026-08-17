import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_insight_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/model/meeting_intelligence_job_entity.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_jobs_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/repository/meeting_intelligence_repository.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_job_coordinator.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/meeting_intelligence_provider.dart';
import 'package:voice2text_flutter/features/meeting_intelligence/service/transcript_batch_planner.dart';
import 'package:voice2text_flutter/features/transcription/model/transcript_segment_entity.dart';

import 'meeting_intelligence_test_fixture.dart';

void main() {
  test(
    'duplicate generation creates one job, one provider call and one note',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final provider = _DynamicProvider(_supportedOutput);
      final coordinator = _coordinator(fixture.appDatabase);
      final request = _request(fixture.request, fixture.request.segments);

      final first = await coordinator.generate(
        provider: provider,
        request: request,
      );
      final second = await coordinator.generate(
        provider: provider,
        request: request,
      );

      expect(first.job.status, MeetingIntelligenceJobStatus.completed);
      expect(second.job.id, first.job.id);
      expect(second.bundle!.note.id, first.bundle!.note.id);
      expect(provider.invocationCount, 1);
      expect(
        (await fixture.database.rawQuery(
          'SELECT COUNT(*) AS count FROM meeting_intelligence_jobs',
        )).single['count'],
        1,
      );
      expect(
        (await fixture.database.rawQuery(
          'SELECT COUNT(*) AS count FROM meeting_notes',
        )).single['count'],
        1,
      );
    },
  );

  test(
    'cancel before request creates a canceled job and sends nothing',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final provider = _DynamicProvider(_supportedOutput);
      final token = MeetingIntelligenceCancellationToken()..cancel();

      final result = await _coordinator(fixture.appDatabase).generate(
        provider: provider,
        request: _request(fixture.request, fixture.request.segments),
        cancellationToken: token,
      );

      expect(result.job.status, MeetingIntelligenceJobStatus.canceled);
      expect(result.job.attemptCount, 0);
      expect(result.bundle, isNull);
      expect(provider.invocationCount, 0);
    },
  );

  test('cancel during request cancels transport and saves no note', () async {
    final fixture = await createMeetingIntelligenceFixture();
    addTearDown(fixture.database.close);
    final started = Completer<void>();
    final provider = _DynamicProvider((request, cancellationToken) {
      final result = Completer<MeetingIntelligenceOutput>();
      cancellationToken!.addListener(() {
        result.completeError(
          const MeetingIntelligenceProviderException(
            MeetingIntelligenceFailureCode.canceled,
            '生成已取消',
          ),
        );
      });
      started.complete();
      return result.future;
    });
    final token = MeetingIntelligenceCancellationToken();
    final future = _coordinator(fixture.appDatabase).generate(
      provider: provider,
      request: _request(fixture.request, fixture.request.segments),
      cancellationToken: token,
    );
    await started.future;
    token.cancel();

    await expectLater(
      future,
      throwsA(
        isA<MeetingIntelligenceProviderException>().having(
          (error) => error.code,
          'code',
          MeetingIntelligenceFailureCode.canceled,
        ),
      ),
    );
    final jobRows = await fixture.database.query('meeting_intelligence_jobs');
    expect(
      MeetingIntelligenceJobEntity.fromMap(jobRows.single).status,
      MeetingIntelligenceJobStatus.canceled,
    );
    expect(
      (await fixture.database.rawQuery(
        'SELECT COUNT(*) AS count FROM meeting_notes',
      )).single['count'],
      0,
    );
  });

  test(
    'failed later batch leaves no partial note and records sanitized failure',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final segments = await _insertSegments(fixture, count: 2);
      var call = 0;
      final provider = _DynamicProvider((request, cancellationToken) async {
        call += 1;
        if (call == 2) {
          throw const MeetingIntelligenceProviderException(
            MeetingIntelligenceFailureCode.serviceUnavailable,
            '云端服务暂时不可用',
          );
        }
        return _supportedOutput(request, cancellationToken);
      });

      await expectLater(
        _coordinator(
          fixture.appDatabase,
          planner: const TranscriptBatchPlanner(
            maximumBatchBytes: 10000,
            maximumSegmentsPerBatch: 1,
          ),
        ).generate(
          provider: provider,
          request: _request(fixture.request, segments),
        ),
        throwsA(isA<MeetingIntelligenceProviderException>()),
      );

      final job = MeetingIntelligenceJobEntity.fromMap(
        (await fixture.database.query('meeting_intelligence_jobs')).single,
      );
      expect(job.status, MeetingIntelligenceJobStatus.failed);
      expect(
        job.errorCode,
        MeetingIntelligenceFailureCode.serviceUnavailable.name,
      );
      expect(
        (await fixture.database.rawQuery(
          'SELECT COUNT(*) AS count FROM meeting_notes',
        )).single['count'],
        0,
      );
    },
  );

  test(
    'hierarchical reduce reads validated candidates and stays in evidence union',
    () async {
      final fixture = await createMeetingIntelligenceFixture();
      addTearDown(fixture.database.close);
      final segments = await _insertSegments(fixture, count: 3);
      var reductionCalls = 0;
      final provider = _DynamicProvider((request, cancellationToken) async {
        if (request.reductionCandidates.isNotEmpty) {
          reductionCalls += 1;
          final permitted = request.reductionCandidates
              .expand((candidate) => candidate.evidence)
              .map((evidence) => evidence.segmentId)
              .toSet();
          expect(
            request.segments.map((segment) => segment.id).toSet(),
            equals(permitted),
          );
        }
        return _supportedOutput(request, cancellationToken);
      });
      final coordinator = _coordinator(
        fixture.appDatabase,
        planner: const TranscriptBatchPlanner(
          maximumBatchBytes: 10000,
          maximumSegmentsPerBatch: 1,
          maximumReduceInputs: 2,
        ),
      );

      final result = await coordinator.generate(
        provider: provider,
        request: _request(fixture.request, segments),
      );

      expect(provider.invocationCount, 6);
      expect(reductionCalls, 3);
      expect(result.job.estimatedRequestCount, 6);
      expect(result.job.progress, 1);
      expect(result.bundle!.insights.single.unsupported, isFalse);
      final evidence = result.bundle!.evidenceByInsight.values.single.single;
      expect(
        segments.map((segment) => segment.id),
        contains(evidence.segmentId),
      );
    },
  );
}

MeetingIntelligenceJobCoordinator _coordinator(
  dynamic appDatabase, {
  TranscriptBatchPlanner planner = const TranscriptBatchPlanner(),
}) {
  return MeetingIntelligenceJobCoordinator(
    jobsRepository: MeetingIntelligenceJobsRepository(database: appDatabase),
    intelligenceRepository: MeetingIntelligenceRepository(
      database: appDatabase,
    ),
    planner: planner,
  );
}

MeetingIntelligenceRequest _request(
  MeetingIntelligenceRequest source,
  List<TranscriptSegmentEntity> segments,
) {
  return MeetingIntelligenceRequest(
    recordingId: source.recordingId,
    generationId: source.generationId,
    processingLocation: MeetingProcessingLocation.cloudDirect,
    consentDecision: MeetingConsentDecision.granted,
    inputStartMs: 0,
    inputEndMs: 10000,
    segments: segments,
    consentAtMs: 123,
    payloadSummary: 'synthetic fixture',
  );
}

Future<List<TranscriptSegmentEntity>> _insertSegments(
  dynamic fixture, {
  required int count,
}) async {
  final segments = <TranscriptSegmentEntity>[fixture.segment];
  for (var index = 1; index < count; index += 1) {
    final startMs = 1000 + index * 2000;
    final endMs = startMs + 1000;
    final id = await fixture.database
        .insert('transcript_segments', <String, Object?>{
          'recording_id': fixture.recordingId,
          'recording_path': '/intelligence.m4a',
          'generation_id': fixture.generationId,
          'sequence_id': index,
          'text': 'Synthetic segment $index.',
          'start_ms': startMs,
          'end_ms': endMs,
          'source': 'test',
          'created_at_ms': 1,
          'updated_at_ms': 1,
        });
    segments.add(
      TranscriptSegmentEntity(
        id: id,
        recordingPath: '/intelligence.m4a',
        recordingId: fixture.recordingId,
        generationId: fixture.generationId,
        jobId: null,
        sequenceId: index,
        text: 'Synthetic segment $index.',
        startMs: startMs,
        endMs: endMs,
        isFinal: true,
        source: 'test',
        confidence: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      ),
    );
  }
  return segments;
}

Future<MeetingIntelligenceOutput> _supportedOutput(
  MeetingIntelligenceRequest request,
  MeetingIntelligenceCancellationToken? cancellationToken,
) async {
  cancellationToken?.throwIfCanceled();
  final segment = request.segments.first;
  return MeetingIntelligenceOutput(
    items: <MeetingInsightCandidate>[
      MeetingInsightCandidate(
        kind: MeetingInsightKind.summary,
        body: request.reductionCandidates.isEmpty
            ? 'Validated map summary'
            : 'Validated reduce summary',
        evidence: <MeetingEvidenceCandidate>[
          MeetingEvidenceCandidate(
            segmentId: segment.id,
            startMs: segment.startMs,
            endMs: segment.endMs,
          ),
        ],
      ),
    ],
  );
}

typedef _GenerateHandler =
    Future<MeetingIntelligenceOutput> Function(
      MeetingIntelligenceRequest request,
      MeetingIntelligenceCancellationToken? cancellationToken,
    );

class _DynamicProvider implements MeetingIntelligenceProvider {
  _DynamicProvider(this.handler);

  final _GenerateHandler handler;
  int invocationCount = 0;

  @override
  MeetingIntelligenceCapabilities get capabilities =>
      MeetingIntelligenceCapabilities(
        processingLocations: const <MeetingProcessingLocation>{
          MeetingProcessingLocation.cloudDirect,
        },
        supportedKinds: MeetingInsightKind.values.toSet(),
      );

  @override
  String get modelId => 'fixture-cloud-v1';

  @override
  String get providerId => 'fixture-cloud';

  @override
  Future<MeetingIntelligenceOutput> generate(
    MeetingIntelligenceRequest request, {
    MeetingIntelligenceCancellationToken? cancellationToken,
  }) {
    invocationCount += 1;
    return handler(request, cancellationToken);
  }
}
