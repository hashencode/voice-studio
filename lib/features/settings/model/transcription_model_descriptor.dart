class TranscriptionModelDescriptor {
  const TranscriptionModelDescriptor({
    required this.id,
    required this.name,
    required this.description,
    required this.offlineReady,
    required this.realtimeReady,
    required this.vadReady,
    required this.punctuationReady,
    required this.denoiseReady,
    required this.selectable,
  });

  final String id;
  final String name;
  final String description;
  final bool offlineReady;
  final bool realtimeReady;
  final bool vadReady;
  final bool punctuationReady;
  final bool denoiseReady;
  final bool selectable;

  bool get canTranscribeOffline => selectable && offlineReady;
  bool get canTranscribeRealtime => selectable && realtimeReady && vadReady;

  static const List<TranscriptionModelDescriptor> known =
      <TranscriptionModelDescriptor>[
        TranscriptionModelDescriptor(
          id: 'paraformer-zh',
          name: 'Paraformer 中文离线模型',
          description: '当前已验证的本地离线识别模型；实时模式会先用它做分段近实时识别。',
          offlineReady: true,
          realtimeReady: true,
          vadReady: true,
          punctuationReady: false,
          denoiseReady: false,
          selectable: true,
        ),
        TranscriptionModelDescriptor(
          id: 'sherpa-streaming-zh',
          name: 'Sherpa Streaming 中文模型',
          description: '预留流式模型入口；当前资源和原生 API 未完成验证，暂不开放选择。',
          offlineReady: false,
          realtimeReady: false,
          vadReady: false,
          punctuationReady: false,
          denoiseReady: false,
          selectable: false,
        ),
        TranscriptionModelDescriptor(
          id: 'sherpa-offline-zh',
          name: 'Sherpa Offline 中文模型',
          description: '历史 UI 选项；当前统一映射到 Paraformer，避免作为独立模型展示。',
          offlineReady: false,
          realtimeReady: false,
          vadReady: false,
          punctuationReady: false,
          denoiseReady: false,
          selectable: false,
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
