class TranscriptionSegmentResult {
  const TranscriptionSegmentResult({
    required this.sequenceId,
    required this.text,
    required this.startMs,
    required this.endMs,
    this.isFinal = true,
    this.source = 'standard_offline',
    this.confidence,
  });

  factory TranscriptionSegmentResult.fromMap(Map<Object?, Object?> map) {
    return TranscriptionSegmentResult(
      sequenceId: (map['sequenceId'] as num?)?.toInt() ?? -1,
      text: map['text'] as String? ?? '',
      startMs: (map['startMs'] as num?)?.toInt() ?? -1,
      endMs: (map['endMs'] as num?)?.toInt() ?? -1,
      isFinal: map['isFinal'] as bool? ?? true,
      source: map['source'] as String? ?? 'standard_offline',
      confidence: (map['confidence'] as num?)?.toDouble(),
    );
  }

  final int sequenceId;
  final String text;
  final int startMs;
  final int endMs;
  final bool isFinal;
  final String source;
  final double? confidence;

  Map<String, Object?> toMap() => <String, Object?>{
    'sequenceId': sequenceId,
    'text': text,
    'startMs': startMs,
    'endMs': endMs,
    'isFinal': isFinal,
    'source': source,
    'confidence': confidence,
  };
}

class TranscriptionResult {
  TranscriptionResult({
    required String mergedText,
    required List<TranscriptionSegmentResult> segments,
  }) : mergedText = mergedText.trim(),
       segments = List<TranscriptionSegmentResult>.unmodifiable(segments) {
    validate();
  }

  factory TranscriptionResult.fromMap(Map<Object?, Object?> map) {
    final rawSegments = map['segments'];
    return TranscriptionResult(
      mergedText: map['mergedText'] as String? ?? '',
      segments: rawSegments is List
          ? rawSegments
                .whereType<Map>()
                .map(
                  (segment) => TranscriptionSegmentResult.fromMap(
                    Map<Object?, Object?>.from(segment),
                  ),
                )
                .toList(growable: false)
          : const <TranscriptionSegmentResult>[],
    );
  }

  factory TranscriptionResult.singleText(
    String text, {
    required int durationMs,
  }) {
    final normalized = text.trim();
    return TranscriptionResult(
      mergedText: normalized,
      segments: <TranscriptionSegmentResult>[
        TranscriptionSegmentResult(
          sequenceId: 0,
          text: normalized,
          startMs: 0,
          endMs: durationMs <= 0 ? 1 : durationMs,
        ),
      ],
    );
  }

  final String mergedText;
  final List<TranscriptionSegmentResult> segments;

  Map<String, Object?> toMap() => <String, Object?>{
    'mergedText': mergedText,
    'segments': segments.map((segment) => segment.toMap()).toList(),
  };

  void validate() {
    if (segments.isEmpty) {
      throw const FormatException('转写结果不包含可持久化片段');
    }
    var previousEndMs = 0;
    final texts = <String>[];
    for (var index = 0; index < segments.length; index += 1) {
      final segment = segments[index];
      final normalizedText = segment.text.trim();
      if (segment.sequenceId != index ||
          normalizedText.isEmpty ||
          segment.startMs < previousEndMs ||
          segment.endMs <= segment.startMs ||
          !segment.isFinal ||
          segment.source.trim().isEmpty ||
          (segment.confidence != null &&
              (segment.confidence! < 0 || segment.confidence! > 1))) {
        throw FormatException('第 $index 个转写片段无效');
      }
      previousEndMs = segment.endMs;
      texts.add(normalizedText);
    }
    if (mergedText != texts.join(' ')) {
      throw const FormatException('合并文本与最终片段顺序不一致');
    }
  }
}
