enum AudioTemplateId {
  general,
  weekly,
  review,
  interview,
  sales,
  retrospective,
  oneOnOne;

  static AudioTemplateId fromStorage(Object? value) {
    return AudioTemplateId.values.firstWhere(
      (template) => template.name == value,
      orElse: () => AudioTemplateId.general,
    );
  }
}

class AudioTemplate {
  const AudioTemplate({
    required this.id,
    required this.label,
    required this.description,
  });

  final AudioTemplateId id;
  final String label;
  final String description;

  static const List<AudioTemplate> known = <AudioTemplate>[
    AudioTemplate(
      id: AudioTemplateId.general,
      label: '通用',
      description: '均衡提取摘要、决策、行动项和风险',
    ),
    AudioTemplate(
      id: AudioTemplateId.weekly,
      label: '周会',
      description: '强调进展、阻塞、决策和下一步',
    ),
    AudioTemplate(
      id: AudioTemplateId.review,
      label: '评审',
      description: '强调结论、修改意见、风险和待确认项',
    ),
    AudioTemplate(
      id: AudioTemplateId.interview,
      label: '访谈',
      description: '强调观点、需求、证据和后续问题',
    ),
    AudioTemplate(
      id: AudioTemplateId.sales,
      label: '销售',
      description: '强调客户需求、异议、承诺和跟进',
    ),
    AudioTemplate(
      id: AudioTemplateId.retrospective,
      label: '复盘',
      description: '强调事实、原因、改进项和负责人',
    ),
    AudioTemplate(
      id: AudioTemplateId.oneOnOne,
      label: '一对一',
      description: '强调反馈、支持事项和双方行动',
    ),
  ];

  static AudioTemplate find(AudioTemplateId id) {
    return known.firstWhere((template) => template.id == id);
  }
}
