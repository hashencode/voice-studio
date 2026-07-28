import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:test/test.dart';

void main() {
  test('template catalog is shared and storage-compatible', () {
    expect(MeetingTemplate.known.map((template) => template.id.name), <String>[
      'general',
      'weekly',
      'review',
      'interview',
      'sales',
      'retrospective',
      'oneOnOne',
    ]);
    expect(MeetingTemplateId.fromStorage('unknown'), MeetingTemplateId.general);
  });

  test('local provider does not require cloud consent', () async {
    final provider = _LocalProvider();
    final output = await MeetingAiWorkflow(
      provider: provider,
    ).generate(_request(MeetingAiConsent.denied));
    expect(output.insights, isEmpty);
    expect(provider.calls, 1);
  });
}

MeetingAiRequest _request(MeetingAiConsent consent) => MeetingAiRequest(
  recordingId: 1,
  generationId: 1,
  consent: consent,
  segments: const <MeetingWorkspaceSegment>[
    MeetingWorkspaceSegment(
      id: 1,
      sequenceId: 0,
      text: 'test',
      startMs: 0,
      endMs: 1000,
      reviewState: MeetingWorkspaceReviewState.reviewed,
      speakerState: MeetingWorkspaceSpeakerState.unknown,
      speakerId: null,
      speakerName: null,
      speakerSource: null,
    ),
  ],
  meetingTitle: 'test',
);

class _LocalProvider implements MeetingAiExtendedProviderPort {
  int calls = 0;

  @override
  MeetingAiProviderDescriptor get descriptor =>
      const MeetingAiProviderDescriptor(
        providerId: 'local-test',
        displayName: 'Local',
        processingLocation: MeetingAiProcessingLocation.localEndpoint,
        requiresSecret: false,
      );

  @override
  String get modelId => 'test';

  @override
  String get providerId => 'local-test';

  @override
  Future<void> cancel() async {}

  @override
  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    calls += 1;
    return const MeetingAiOutput(insights: <MeetingAiInsight>[]);
  }

  @override
  Future<bool> isConfigured() async => true;

  @override
  Future<MeetingAiAvailability> probeAvailability() async =>
      const MeetingAiAvailability.available();
}
