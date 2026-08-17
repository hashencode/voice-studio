import 'package:audio_core/audio_core.dart';
import 'package:audio_workflows/audio_workflows.dart';
import 'package:test/test.dart';

void main() {
  test('Audio workflow targets use the Audio domain identity', () {
    final target = AudioWorkflowTarget(audioId: AudioId('audio-1'));
    expect(target.audioId.value, 'audio-1');
  });
}
