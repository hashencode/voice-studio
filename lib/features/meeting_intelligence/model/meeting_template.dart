enum MeetingTemplateId {
  general,
  weekly,
  review,
  interview,
  sales,
  retrospective,
  oneOnOne;

  static MeetingTemplateId fromStorage(Object? value) {
    return MeetingTemplateId.values.firstWhere(
      (template) => template.name == value,
      orElse: () => MeetingTemplateId.general,
    );
  }
}

class MeetingTemplate {
  const MeetingTemplate({
    required this.id,
    required this.label,
    required this.description,
  });

  final MeetingTemplateId id;
  final String label;
  final String description;

  static const List<MeetingTemplate> known = <MeetingTemplate>[
    MeetingTemplate(
      id: MeetingTemplateId.general,
      label: '通用',
      description: '均衡提取摘要、决策、行动项和风险',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.weekly,
      label: '周会',
      description: '强调进展、阻塞、决策和下一步',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.review,
      label: '评审',
      description: '强调结论、修改意见、风险和待确认项',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.interview,
      label: '访谈',
      description: '强调观点、需求、证据和后续问题',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.sales,
      label: '销售',
      description: '强调客户需求、异议、承诺和跟进',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.retrospective,
      label: '复盘',
      description: '强调事实、原因、改进项和负责人',
    ),
    MeetingTemplate(
      id: MeetingTemplateId.oneOnOne,
      label: '一对一',
      description: '强调反馈、支持事项和双方行动',
    ),
  ];

  static MeetingTemplate find(MeetingTemplateId id) {
    return known.firstWhere((template) => template.id == id);
  }
}
