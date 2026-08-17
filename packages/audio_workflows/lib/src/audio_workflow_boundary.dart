import 'package:audio_core/audio_core.dart';

/// Input shared by future Audio workflows without retaining Meeting aliases.
final class AudioWorkflowTarget {
  const AudioWorkflowTarget({required this.audioId});

  final AudioId audioId;
}
