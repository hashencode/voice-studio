import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:voice2text_desktop/features/captions/live_caption_models.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('U14 handoff contract preserves frozen authority identities', (
    tester,
  ) async {
    expect(senseVoiceLiveDraftSource, 'sensevoice_live_draft');
    expect(qwen3PostMeetingSource, 'qwen3_post_meeting');
    expect(senseVoiceU18ControlProfile, 'U18_CONTROL_RETAINED');
    expect(liveCaptionSpoolRelativePath, 'caption/live-caption.pcmspool');
    expect(liveCaptionSampleRate, 16000);
    final utterance = LiveCaptionUtterance(
      sessionId: 'session-u14-integration',
      generationId: 1,
      sequence: 1,
      startMs: 100,
      endMs: 900,
      text: '真实转写由物理机 smoke 单独证明',
      language: 'zh',
      modelSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workerOffsetBytes: 32000,
    );
    expect(utterance.workerOffsetBytes, 10 * 3200);
  });
}
