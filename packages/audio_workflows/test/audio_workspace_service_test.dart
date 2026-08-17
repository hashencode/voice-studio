import 'package:audio_workflows/audio_workflows.dart';
import 'package:test/test.dart';

void main() {
  const segment = AudioWorkspaceSegment(
    id: 11,
    sequenceId: 0,
    text: '确认下周发布。',
    startMs: 1000,
    endMs: 3200,
    reviewState: AudioWorkspaceReviewState.reviewed,
    speakerState: AudioWorkspaceSpeakerState.assigned,
    speakerId: 7,
    speakerName: '说话人 1',
    speakerSource: 'manual',
  );
  const snapshot = AudioWorkspaceSnapshot(
    summary: AudioWorkspaceSummary(
      recordingId: 1,
      displayName: '项目周会',
      filePath: '/private/audio.wav',
      durationMs: 3200,
      createdAtMs: 1,
      processingState: AudioWorkspaceProcessingState.completed,
      generationId: 3,
      segmentCount: 1,
    ),
    segments: <AudioWorkspaceSegment>[segment],
    speakers: <AudioWorkspaceSpeaker>[
      AudioWorkspaceSpeaker(
        id: 7,
        stableKey: 'speaker-1',
        displayName: '说话人 1',
        source: 'manual',
        mergedIntoSpeakerId: null,
      ),
    ],
    insights: <AudioWorkspaceInsight>[
      AudioWorkspaceInsight(
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
    final service = AudioWorkspaceService(port: port);

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
        state: AudioWorkspaceSpeakerState.unknown,
      ),
      throwsArgumentError,
    );
  });

  test('exports reviewed transcript, speaker and evidence in all formats', () {
    final service = AudioWorkspaceService(port: _WorkspacePort());

    final text = service.export(snapshot, AudioWorkspaceExportFormat.text);
    final markdown = service.export(
      snapshot,
      AudioWorkspaceExportFormat.markdown,
    );
    final vtt = service.export(snapshot, AudioWorkspaceExportFormat.webVtt);
    final srt = service.export(snapshot, AudioWorkspaceExportFormat.srt);
    final json = service.export(snapshot, AudioWorkspaceExportFormat.json);

    expect(text.contents, contains('说话人 1：确认下周发布。'));
    expect(markdown.contents, contains('准备发布清单'));
    expect(vtt.contents, startsWith('WEBVTT'));
    expect(vtt.contents, contains('00:00:01.000 --> 00:00:03.200'));
    expect(srt.contents, contains('00:00:01,000 --> 00:00:03,200'));
    expect(json.contents, contains('"evidenceSegmentIds"'));
    expect(json.contents, contains('"speakerName": "说话人 1"'));
  });

  test('maps every persisted processing state without hiding recovery', () {
    final cases = <(String, String), AudioWorkspaceProcessingState>{
      ('pending', 'model_missing'): AudioWorkspaceProcessingState.modelMissing,
      ('pending', 'installing'): AudioWorkspaceProcessingState.installing,
      ('pending', 'queued'): AudioWorkspaceProcessingState.queued,
      ('processing', 'preparing'): AudioWorkspaceProcessingState.preparing,
      ('processing', 'asr'): AudioWorkspaceProcessingState.asr,
      ('processing', 'diarization'): AudioWorkspaceProcessingState.diarization,
      ('completed', 'partial_success'):
          AudioWorkspaceProcessingState.partialSuccess,
      ('completed', 'completed'): AudioWorkspaceProcessingState.completed,
      ('processing', 'canceling'): AudioWorkspaceProcessingState.canceling,
      ('canceled', 'canceled'): AudioWorkspaceProcessingState.canceled,
      ('failed', 'retryable_failure'):
          AudioWorkspaceProcessingState.retryableFailure,
      ('failed', 'terminal_failure'):
          AudioWorkspaceProcessingState.terminalFailure,
      ('failed', 'recovery_unknown'):
          AudioWorkspaceProcessingState.recoveryUnknown,
    };

    for (final entry in cases.entries) {
      expect(
        AudioWorkspaceProcessingState.fromStorage(
          status: entry.key.$1,
          stage: entry.key.$2,
        ),
        entry.value,
      );
    }
  });

  test('AI consent is checked before secret lookup or provider call', () async {
    final provider = _AiProvider();
    final workflow = AudioAiWorkflow(provider: provider);
    final request = AudioAiRequest(
      recordingId: 1,
      generationId: 3,
      consent: AudioAiConsent.denied,
      segments: const <AudioWorkspaceSegment>[segment],
      audioTitle: '项目周会',
    );

    await expectLater(
      workflow.generate(request),
      throwsA(
        isA<AudioAiFailure>().having(
          (failure) => failure.code,
          'code',
          AudioAiFailureCode.consentRequired,
        ),
      ),
    );
    expect(provider.configurationReads, 0);
    expect(provider.generateCalls, 0);
  });

  test('AI output cannot cite absent or out-of-range evidence', () async {
    final provider = _AiProvider(
      output: const AudioAiOutput(
        insights: <AudioAiInsight>[
          AudioAiInsight(
            kind: 'decision',
            body: '发布',
            evidence: <AudioAiEvidence>[
              AudioAiEvidence(segmentId: 11, startMs: 0, endMs: 3200),
            ],
          ),
        ],
      ),
    );
    final workflow = AudioAiWorkflow(provider: provider);

    await expectLater(
      workflow.generate(
        const AudioAiRequest(
          recordingId: 1,
          generationId: 3,
          consent: AudioAiConsent.granted,
          segments: <AudioWorkspaceSegment>[segment],
          audioTitle: '项目周会',
        ),
      ),
      throwsA(
        isA<AudioAiFailure>().having(
          (failure) => failure.code,
          'code',
          AudioAiFailureCode.invalidOutput,
        ),
      ),
    );
  });
}

class _WorkspacePort implements AudioWorkspacePort {
  final searchResult = <AudioWorkspaceSegment>[];
  String? lastQuery;

  @override
  Future<void> assignSpeaker({
    required int generationId,
    required int segmentId,
    required int? speakerId,
    required AudioWorkspaceSpeakerState state,
  }) async {}

  @override
  Future<List<AudioWorkspaceSummary>> listAudios({
    String query = '',
    int limit = 200,
    int offset = 0,
  }) async => const <AudioWorkspaceSummary>[];

  @override
  Future<void> mergeSpeakers({
    required int generationId,
    required int targetSpeakerId,
    required Set<int> sourceSpeakerIds,
  }) async {}

  @override
  Future<AudioWorkspaceSnapshot?> openAudio(int recordingId) async => null;

  @override
  Future<bool> redo(int generationId) async => false;

  @override
  Future<void> renameSpeakers(Map<int, String> names) async {}

  @override
  Future<bool> saveSegment({
    required int segmentId,
    required String text,
    required AudioWorkspaceReviewState reviewState,
  }) async => true;

  @override
  Future<List<AudioWorkspaceSegment>> searchTranscript({
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

class _AiProvider implements AudioAiProviderPort {
  _AiProvider({
    this.output = const AudioAiOutput(insights: <AudioAiInsight>[]),
  });

  final AudioAiOutput output;
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
  Future<AudioAiOutput> generate(AudioAiRequest request) async {
    generateCalls += 1;
    return output;
  }
}
