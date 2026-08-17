import 'dart:convert';

import '../model/audio_insight_entity.dart';
import 'audio_intelligence_provider.dart';

class AudioIntelligenceOutputCodec {
  const AudioIntelligenceOutputCodec();

  static const schemaVersion = 'audio_intelligence_output/v1';
  static const _topLevelFields = <String>{
    'schema_version',
    'audio_type',
    'suggested_title',
    'items',
  };
  static const _itemFields = <String>{
    'kind',
    'body',
    'evidence',
    'action_owner',
    'action_due_at_ms',
    'resolution_state',
    'topic_start_ms',
    'topic_end_ms',
    'sort_order',
  };
  static const _evidenceFields = <String>{'segment_id', 'start_ms', 'end_ms'};

  AudioIntelligenceOutput decode(String source) {
    if (source.trim().isEmpty) {
      throw const FormatException('云端返回了空的结构化结果');
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(source);
    } on FormatException {
      throw const FormatException('云端结果不是有效 JSON');
    }
    final root = _object(decoded, '根对象');
    _rejectUnknown(root, _topLevelFields, '根对象');
    final version = _requiredString(root, 'schema_version', maximum: 80);
    if (version != schemaVersion) {
      throw FormatException('不支持的音频智能输出版本：$version');
    }
    final rawItems = root['items'];
    if (rawItems is! List || rawItems.length > 200) {
      throw const FormatException('音频智能条目列表无效');
    }
    final items = <AudioInsightCandidate>[];
    for (var index = 0; index < rawItems.length; index += 1) {
      items.add(_decodeItem(rawItems[index], index));
    }
    return AudioIntelligenceOutput(
      schemaVersion: version,
      audioType: _optionalString(root, 'audio_type', maximum: 100),
      suggestedTitle: _optionalString(root, 'suggested_title', maximum: 200),
      items: items,
    );
  }

  Map<String, Object?> schemaExample() {
    return <String, Object?>{
      'schema_version': schemaVersion,
      'audio_type': 'weekly',
      'suggested_title': '标题建议',
      'items': <Object?>[
        <String, Object?>{
          'kind': 'decision',
          'body': '已确认的决定',
          'evidence': <Object?>[
            <String, Object?>{
              'segment_id': 1,
              'start_ms': 1000,
              'end_ms': 2500,
            },
          ],
          'action_owner': null,
          'action_due_at_ms': null,
          'resolution_state': 'notApplicable',
          'topic_start_ms': null,
          'topic_end_ms': null,
          'sort_order': 0,
        },
      ],
    };
  }

  AudioInsightCandidate _decodeItem(Object? value, int index) {
    final item = _object(value, '条目 $index');
    _rejectUnknown(item, _itemFields, '条目 $index');
    final kindName = _requiredString(item, 'kind', maximum: 40);
    final kind = _findByName(
      AudioInsightKind.values,
      (candidate) => candidate.name,
      kindName,
    );
    if (kind == null) {
      throw FormatException('条目 $index 的类型无效');
    }
    final rawEvidence = item['evidence'];
    if (rawEvidence is! List || rawEvidence.length > 20) {
      throw FormatException('条目 $index 的证据列表无效');
    }
    final evidence = <AudioEvidenceCandidate>[];
    for (
      var evidenceIndex = 0;
      evidenceIndex < rawEvidence.length;
      evidenceIndex += 1
    ) {
      final record = _object(
        rawEvidence[evidenceIndex],
        '条目 $index 的证据 $evidenceIndex',
      );
      _rejectUnknown(record, _evidenceFields, '条目 $index 的证据 $evidenceIndex');
      evidence.add(
        AudioEvidenceCandidate(
          segmentId: _requiredInt(record, 'segment_id'),
          startMs: _requiredInt(record, 'start_ms'),
          endMs: _requiredInt(record, 'end_ms'),
        ),
      );
    }
    final resolutionName =
        _optionalString(item, 'resolution_state', maximum: 40) ??
        AudioInsightResolutionState.notApplicable.name;
    final resolutionState = _findByName(
      AudioInsightResolutionState.values,
      (candidate) => candidate.name,
      resolutionName,
    );
    if (resolutionState == null) {
      throw FormatException('条目 $index 的解决状态无效');
    }
    return AudioInsightCandidate(
      kind: kind,
      body: _requiredString(item, 'body', maximum: 4000),
      evidence: evidence,
      actionOwner: _optionalString(item, 'action_owner', maximum: 200),
      actionDueAtMs: _optionalInt(item, 'action_due_at_ms'),
      resolutionState: resolutionState,
      topicStartMs: _optionalInt(item, 'topic_start_ms'),
      topicEndMs: _optionalInt(item, 'topic_end_ms'),
      sortOrder: _optionalInt(item, 'sort_order') ?? index,
    );
  }

  Map<String, Object?> _object(Object? value, String label) {
    if (value is! Map) {
      throw FormatException('$label 必须是对象');
    }
    if (value.keys.any((key) => key is! String)) {
      throw FormatException('$label 包含无效字段');
    }
    return value.cast<String, Object?>();
  }

  void _rejectUnknown(
    Map<String, Object?> value,
    Set<String> allowed,
    String label,
  ) {
    if (value.keys.any((key) => !allowed.contains(key))) {
      throw FormatException('$label 包含未知字段');
    }
  }

  String _requiredString(
    Map<String, Object?> value,
    String key, {
    required int maximum,
  }) {
    final result = _optionalString(value, key, maximum: maximum);
    if (result == null) {
      throw FormatException('$key 必须是非空文本');
    }
    return result;
  }

  String? _optionalString(
    Map<String, Object?> value,
    String key, {
    required int maximum,
  }) {
    final raw = value[key];
    if (raw == null) return null;
    if (raw is! String) {
      throw FormatException('$key 必须是文本或 null');
    }
    final normalized = raw.trim();
    if (normalized.isEmpty || normalized.length > maximum) {
      throw FormatException('$key 长度无效');
    }
    return normalized;
  }

  int _requiredInt(Map<String, Object?> value, String key) {
    final result = _optionalInt(value, key);
    if (result == null) {
      throw FormatException('$key 必须是整数');
    }
    return result;
  }

  int? _optionalInt(Map<String, Object?> value, String key) {
    final raw = value[key];
    if (raw == null) return null;
    if (raw is! int) {
      throw FormatException('$key 必须是整数或 null');
    }
    return raw;
  }

  T? _findByName<T>(
    Iterable<T> values,
    String Function(T value) nameOf,
    String name,
  ) {
    for (final value in values) {
      if (nameOf(value) == name) return value;
    }
    return null;
  }
}
