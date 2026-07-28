import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:sqflite/sqflite.dart';

import '../meeting_intelligence/openai_compatible_desktop_provider.dart';

class DesktopAiProviderSettings {
  const DesktopAiProviderSettings({
    required this.providerId,
    required this.modelId,
    required this.endpoint,
  });

  static const deepSeek = DesktopAiProviderSettings(
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com',
  );

  static const openAiCompatible = DesktopAiProviderSettings(
    providerId: 'openai-compatible',
    modelId: '',
    endpoint: 'https://example.invalid',
  );

  final String providerId;
  final String modelId;
  final String endpoint;

  String get displayName => switch (providerId) {
    'deepseek' => 'DeepSeek',
    'openai-compatible' => 'OpenAI-compatible',
    _ => providerId,
  };

  bool get requiresSecret => true;

  MeetingAiProcessingLocation get processingLocation =>
      MeetingAiProcessingLocation.cloudDirect;

  bool get requiresMeetingConsent => true;

  DesktopAiProviderSettings validated() {
    if (!const <String>{'deepseek', 'openai-compatible'}.contains(providerId)) {
      throw ArgumentError.value(providerId, 'providerId');
    }
    final normalizedModel = modelId.trim();
    if (normalizedModel.isEmpty || normalizedModel.runes.length > 256) {
      throw ArgumentError.value(modelId, 'modelId');
    }
    final parsed = DesktopAiEndpoint.parse(endpoint);
    if (providerId == 'openai-compatible' && parsed.isLoopback) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidConfiguration,
        '自定义会议智能接口必须使用远程 HTTPS 地址',
      );
    }
    if (providerId == 'deepseek' &&
        (parsed.baseUri.scheme != 'https' ||
            parsed.baseUri.host != 'api.deepseek.com')) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidConfiguration,
        'DeepSeek 地址不可修改',
      );
    }
    return DesktopAiProviderSettings(
      providerId: providerId,
      modelId: normalizedModel,
      endpoint: parsed.baseUri.toString().replaceAll(RegExp(r'/+$'), ''),
    );
  }
}

class DesktopAiProviderSettingsRepository {
  const DesktopAiProviderSettingsRepository({required AppDatabase database})
    : _database = database;

  final AppDatabase _database;

  Future<DesktopAiProviderSettings> load() async {
    final database = await _database.database;
    final rows = await database.query(
      'app_settings',
      columns: <String>[
        'meeting_ai_provider_id',
        'meeting_ai_model_id',
        'meeting_ai_endpoint',
      ],
      where: 'id = ?',
      whereArgs: const <Object>[1],
      limit: 1,
    );
    if (rows.isEmpty) return DesktopAiProviderSettings.deepSeek;
    final row = rows.single;
    final providerId =
        row['meeting_ai_provider_id'] as String? ??
        DesktopAiProviderSettings.deepSeek.providerId;
    final fallback = switch (providerId) {
      'openai-compatible' => DesktopAiProviderSettings.openAiCompatible,
      _ => DesktopAiProviderSettings.deepSeek,
    };
    try {
      return DesktopAiProviderSettings(
        providerId: providerId,
        modelId: row['meeting_ai_model_id'] as String? ?? fallback.modelId,
        endpoint: row['meeting_ai_endpoint'] as String? ?? fallback.endpoint,
      ).validated();
    } on Object {
      return DesktopAiProviderSettings.deepSeek;
    }
  }

  Future<void> save(DesktopAiProviderSettings value) async {
    final settings = value.validated();
    final database = await _database.database;
    await database.transaction<void>((transaction) async {
      await transaction.insert('app_settings', <String, Object?>{
        'id': 1,
        'model_id': 'qwen3-asr-0.6b-int8',
        'auto_transcribe': 0,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      await transaction.update(
        'app_settings',
        <String, Object?>{
          'meeting_ai_provider_id': settings.providerId,
          'meeting_ai_model_id': settings.modelId,
          'meeting_ai_endpoint': settings.endpoint,
          // This compatibility flag is intentionally not a source of truth.
          // Keychain is queried directly whenever the selected provider changes.
          'meeting_ai_secret_configured': 0,
        },
        where: 'id = ?',
        whereArgs: const <Object>[1],
      );
    });
  }
}
