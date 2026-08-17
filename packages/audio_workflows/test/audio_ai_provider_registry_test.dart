import 'package:audio_workflows/audio_workflows.dart';
import 'package:test/test.dart';

void main() {
  test('template catalog is shared and storage-compatible', () {
    expect(AudioTemplate.known.map((template) => template.id.name), <String>[
      'general',
      'weekly',
      'review',
      'interview',
      'sales',
      'retrospective',
      'oneOnOne',
    ]);
    expect(AudioTemplateId.fromStorage('unknown'), AudioTemplateId.general);
  });

  test('local provider does not require cloud consent', () async {
    final provider = _LocalProvider();
    final output = await AudioAiWorkflow(
      provider: provider,
    ).generate(_request(AudioAiConsent.denied));
    expect(output.insights, isEmpty);
    expect(provider.calls, 1);
  });
}

AudioAiRequest _request(AudioAiConsent consent) => AudioAiRequest(
  recordingId: 1,
  generationId: 1,
  consent: consent,
  segments: const <AudioWorkspaceSegment>[
    AudioWorkspaceSegment(
      id: 1,
      sequenceId: 0,
      text: 'test',
      startMs: 0,
      endMs: 1000,
      reviewState: AudioWorkspaceReviewState.reviewed,
      speakerState: AudioWorkspaceSpeakerState.unknown,
      speakerId: null,
      speakerName: null,
      speakerSource: null,
    ),
  ],
  audioTitle: 'test',
);

class _LocalProvider implements AudioAiExtendedProviderPort {
  int calls = 0;

  @override
  AudioAiProviderDescriptor get descriptor => const AudioAiProviderDescriptor(
    providerId: 'local-test',
    displayName: 'Local',
    processingLocation: AudioAiProcessingLocation.localEndpoint,
    requiresSecret: false,
  );

  @override
  String get modelId => 'test';

  @override
  String get providerId => 'local-test';

  @override
  Future<void> cancel() async {}

  @override
  Future<AudioAiOutput> generate(AudioAiRequest request) async {
    calls += 1;
    return const AudioAiOutput(insights: <AudioAiInsight>[]);
  }

  @override
  Future<bool> isConfigured() async => true;

  @override
  Future<AudioAiAvailability> probeAvailability() async =>
      const AudioAiAvailability.available();
}
