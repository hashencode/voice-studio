import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:test/test.dart';

void main() {
  const segment = MeetingWorkspaceSegment(
    id: 11,
    sequenceId: 0,
    text: '确认下周发布。',
    startMs: 1000,
    endMs: 3200,
    reviewState: MeetingWorkspaceReviewState.reviewed,
    speakerState: MeetingWorkspaceSpeakerState.assigned,
    speakerId: 7,
    speakerName: '说话人 1',
    speakerSource: 'manual',
  );
  const snapshot = MeetingWorkspaceSnapshot(
    summary: MeetingWorkspaceSummary(
      recordingId: 1,
      displayName: '项目周会',
      filePath: '/private/meeting.wav',
      durationMs: 3200,
      createdAtMs: 1,
      processingState: MeetingWorkspaceProcessingState.completed,
      generationId: 3,
      segmentCount: 1,
    ),
    segments: <MeetingWorkspaceSegment>[segment],
    speakers: <MeetingWorkspaceSpeaker>[
      MeetingWorkspaceSpeaker(
        id: 7,
        stableKey: 'speaker-1',
        displayName: '说话人 1',
        source: 'manual',
        mergedIntoSpeakerId: null,
      ),
    ],
    insights: <MeetingWorkspaceInsight>[
      MeetingWorkspaceInsight(
        id: 9,
        kind: 'action_item',
        body: '准备发布清单',
        status: 'draft',
        evidenceSegmentIds: <int>[11],
      ),
    ],
    canUndo: true,
    canRedo: false,
  );

  test('validates bounded searches and preserves normalized queries', () async {
    final port = _WorkspacePort();
    final service = MeetingWorkspaceService(port: port);

    expect(
      await service.searchTranscript(recordingId: 1, query: '  发布  '),
      same(port.searchResult),
    );
    expect(port.lastQuery, '发布');
    expect(
      () => service.searchTranscript(
        recordingId: 1,
        query: '发布',
        startMs: 3000,
        endMs: 1000,
      ),
      throwsArgumentError,
    );
    expect(
      () => service.assignSpeaker(
        generationId: 1,
        segmentId: 11,
        speakerId: 7,
        state: MeetingWorkspaceSpeakerState.unknown,
      ),
      throwsArgumentError,
    );
  });

  test('exports reviewed transcript, speaker and evidence in all formats', () {
    final service = MeetingWorkspaceService(port: _WorkspacePort());

    final text = service.export(snapshot, MeetingWorkspaceExportFormat.text);
    final markdown = service.export(
      snapshot,
      MeetingWorkspaceExportFormat.markdown,
    );
    final vtt = service.export(snapshot, MeetingWorkspaceExportFormat.webVtt);
    final srt = service.export(snapshot, MeetingWorkspaceExportFormat.srt);
    final json = service.export(snapshot, MeetingWorkspaceExportFormat.json);

    expect(text.contents, contains('说话人 1：确认下周发布。'));
    expect(markdown.contents, contains('准备发布清单'));
    expect(vtt.contents, startsWith('WEBVTT'));
    expect(vtt.contents, contains('00:00:01.000 --> 00:00:03.200'));
    expect(srt.contents, contains('00:00:01,000 --> 00:00:03,200'));
    expect(json.contents, contains('"evidenceSegmentIds"'));
    expect(json.contents, contains('"speakerName": "说话人 1"'));
  });

  test('maps every persisted processing state without hiding recovery', () {
    final cases = <(String, String), MeetingWorkspaceProcessingState>{
      ('pending', 'model_missing'):
          MeetingWorkspaceProcessingState.modelMissing,
      ('pending', 'installing'): MeetingWorkspaceProcessingState.installing,
      ('pending', 'queued'): MeetingWorkspaceProcessingState.queued,
      ('processing', 'preparing'): MeetingWorkspaceProcessingState.preparing,
      ('processing', 'asr'): MeetingWorkspaceProcessingState.asr,
      ('processing', 'diarization'):
          MeetingWorkspaceProcessingState.diarization,
      ('completed', 'partial_success'):
          MeetingWorkspaceProcessingState.partialSuccess,
      ('completed', 'completed'): MeetingWorkspaceProcessingState.completed,
      ('processing', 'canceling'): MeetingWorkspaceProcessingState.canceling,
      ('canceled', 'canceled'): MeetingWorkspaceProcessingState.canceled,
      ('failed', 'retryable_failure'):
          MeetingWorkspaceProcessingState.retryableFailure,
      ('failed', 'terminal_failure'):
          MeetingWorkspaceProcessingState.terminalFailure,
      ('failed', 'recovery_unknown'):
          MeetingWorkspaceProcessingState.recoveryUnknown,
    };

    for (final entry in cases.entries) {
      expect(
        MeetingWorkspaceProcessingState.fromStorage(
          status: entry.key.$1,
          stage: entry.key.$2,
        ),
        entry.value,
      );
    }
  });

  test('AI consent is checked before secret lookup or provider call', () async {
    final provider = _AiProvider();
    final workflow = MeetingAiWorkflow(provider: provider);
    final request = MeetingAiRequest(
      recordingId: 1,
      generationId: 3,
      consent: MeetingAiConsent.denied,
      segments: const <MeetingWorkspaceSegment>[segment],
      meetingTitle: '项目周会',
    );

    await expectLater(
      workflow.generate(request),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.consentRequired,
        ),
      ),
    );
    expect(provider.configurationReads, 0);
    expect(provider.generateCalls, 0);
  });

  test('AI output cannot cite absent or out-of-range evidence', () async {
    final provider = _AiProvider(
      output: const MeetingAiOutput(
        insights: <MeetingAiInsight>[
          MeetingAiInsight(
            kind: 'decision',
            body: '发布',
            evidence: <MeetingAiEvidence>[
              MeetingAiEvidence(segmentId: 11, startMs: 0, endMs: 3200),
            ],
          ),
        ],
      ),
    );
    final workflow = MeetingAiWorkflow(provider: provider);

    await expectLater(
      workflow.generate(
        const MeetingAiRequest(
          recordingId: 1,
          generationId: 3,
          consent: MeetingAiConsent.granted,
          segments: <MeetingWorkspaceSegment>[segment],
          meetingTitle: '项目周会',
        ),
      ),
      throwsA(
        isA<MeetingAiFailure>().having(
          (failure) => failure.code,
          'code',
          MeetingAiFailureCode.invalidOutput,
        ),
      ),
    );
  });
}

class _WorkspacePort implements MeetingWorkspacePort {
  final searchResult = <MeetingWorkspaceSegment>[];
  String? lastQuery;

  @override
  Future<void> assignSpeaker({
    required int generationId,
    required int segmentId,
    required int? speakerId,
    required MeetingWorkspaceSpeakerState state,
  }) async {}

  @override
  Future<List<MeetingWorkspaceSummary>> listMeetings({
    String query = '',
    int limit = 200,
    int offset = 0,
  }) async => const <MeetingWorkspaceSummary>[];

  @override
  Future<void> mergeSpeakers({
    required int generationId,
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) async {}

  @override
  Future<MeetingWorkspaceSnapshot?> openMeeting(int recordingId) async => null;

  @override
  Future<bool> redo(int generationId) async => false;

  @override
  Future<void> renameSpeakers(Map<int, String> names) async {}

  @override
  Future<bool> saveSegment({
    required int segmentId,
    required String text,
    required MeetingWorkspaceReviewState reviewState,
  }) async => true;

  @override
  Future<List<MeetingWorkspaceSegment>> searchTranscript({
    required int recordingId,
    required String query,
    int? startMs,
    int? endMs,
    int? speakerId,
    int limit = 200,
  }) async {
    lastQuery = query;
    return searchResult;
  }

  @override
  Future<bool> undo(int generationId) async => false;
}

class _AiProvider implements MeetingAiProviderPort {
  _AiProvider({
    this.output = const MeetingAiOutput(insights: <MeetingAiInsight>[]),
  });

  final MeetingAiOutput output;
  int configurationReads = 0;
  int generateCalls = 0;

  @override
  String get modelId => 'test-model';

  @override
  String get providerId => 'test-provider';

  @override
  Future<bool> isConfigured() async {
    configurationReads += 1;
    return true;
  }

  @override
  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    generateCalls += 1;
    return output;
  }
}
