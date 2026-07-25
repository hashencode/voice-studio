class TranscriptionCapabilityGate {
  const TranscriptionCapabilityGate({
    required this.available,
    required this.verified,
    required this.reason,
  }) : assert(!verified || available),
       assert(verified || reason != '');

  final bool available;
  final bool verified;
  final String reason;
}

class TranscriptionModelDescriptor {
  const TranscriptionModelDescriptor({
    required this.id,
    required this.name,
    required this.description,
    required this.offlineReady,
    required this.vadReady,
    required this.punctuationReady,
    required this.itn,
    required this.confidence,
    required this.hotwords,
    required this.enhancement,
    required this.selectable,
  });

  final String id;
  final String name;
  final String description;
  final bool offlineReady;
  final bool vadReady;
  final bool punctuationReady;
  final TranscriptionCapabilityGate itn;
  final TranscriptionCapabilityGate confidence;
  final TranscriptionCapabilityGate hotwords;
  final TranscriptionCapabilityGate enhancement;
  final bool selectable;

  bool get canTranscribeOffline => selectable && offlineReady;
  bool get denoiseReady => enhancement.verified;

  static const List<TranscriptionModelDescriptor> known =
      <TranscriptionModelDescriptor>[
        TranscriptionModelDescriptor(
          id: 'paraformer-zh',
          name: 'Paraformer 中文离线模型',
          description: '当前已验证的本地离线识别模型；录音保存后使用 VAD 切片识别。',
          offlineReady: true,
          vadReady: true,
          punctuationReady: true,
          itn: TranscriptionCapabilityGate(
            available: false,
            verified: false,
            reason: 'itn_asset_missing',
          ),
          confidence: TranscriptionCapabilityGate(
            available: false,
            verified: false,
            reason: 'recognizer_confidence_unavailable',
          ),
          hotwords: TranscriptionCapabilityGate(
            available: false,
            verified: false,
            reason: 'paraformer_hotwords_unsupported',
          ),
          enhancement: TranscriptionCapabilityGate(
            available: true,
            verified: false,
            reason: 'enhancement_benchmark_pending',
          ),
          selectable: true,
        ),
      ];

  static TranscriptionModelDescriptor? findById(String id) {
    for (final TranscriptionModelDescriptor descriptor in known) {
      if (descriptor.id == id) {
        return descriptor;
      }
    }
    return null;
  }

  static TranscriptionModelDescriptor defaultModel() => known.first;
}
