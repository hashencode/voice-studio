import 'package:flutter/services.dart';
import 'package:sqflite/sqflite.dart';

import '../../../app/contracts/audio_contract.dart';
import '../../../data/sqlite/app_database.dart';
import '../model/diagnostic_report.dart';

class DiagnosticReportService {
  DiagnosticReportService({
    AppDatabase? database,
    MethodChannel? channel,
    DateTime Function()? now,
  }) : _database = database ?? AppDatabase.instance,
       _channel = channel ?? const MethodChannel(AudioContract.recorderChannel),
       _now = now ?? DateTime.now;

  static const Set<String> _knownStatuses = <String>{
    'pending',
    'processing',
    'completed',
    'failed',
    'canceled',
  };
  static const Set<String> _knownStages = <String>{
    'queued',
    'model_load',
    'preprocess',
    'decode',
    'postprocess',
    'persistence',
    'cancellation',
    'completed',
    'failed',
    'canceled',
    'unknown',
  };
  static final RegExp _safeBuildToken = RegExp(r'^[A-Za-z0-9_.+-]{1,80}$');
  static final RegExp _safeErrorCategory = RegExp(r'^[A-Z0-9_]{1,64}$');

  final AppDatabase _database;
  final MethodChannel _channel;
  final DateTime Function() _now;

  Future<DiagnosticReport> build() async {
    final buildInfo = await _loadBuildInfo();
    final deviceProtection = await _loadDeviceProtection();
    final transcription = await _loadTranscriptionSummary();
    return DiagnosticReport(
      generatedAtMs: _now().millisecondsSinceEpoch,
      build: buildInfo,
      deviceProtection: deviceProtection,
      transcription: transcription,
    );
  }

  Future<DiagnosticBuildInfo> _loadBuildInfo() async {
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(
        'getBuildInfo',
      );
      return DiagnosticBuildInfo(
        packageName: _safeBuildValue(raw?['packageName']),
        versionName: _safeBuildValue(raw?['versionName']),
      );
    } catch (_) {
      return const DiagnosticBuildInfo(
        packageName: 'unknown',
        versionName: 'unknown',
      );
    }
  }

  Future<DiagnosticDeviceProtection> _loadDeviceProtection() async {
    try {
      final raw = await _channel.invokeMapMethod<Object?, Object?>(
        'getDeviceProtection',
      );
      final storageScope = raw?['storageScope'] == 'app_private_internal'
          ? 'app_private_internal'
          : 'unknown';
      final protectionCategory =
          raw?['protectionCategory'] == 'device_security_managed'
          ? 'device_security_managed'
          : 'unknown';
      final backupPolicy = raw?['backupPolicy'] == 'app_data_excluded'
          ? 'app_data_excluded'
          : 'unknown';
      return DiagnosticDeviceProtection(
        storageScope: storageScope,
        protectionCategory: protectionCategory,
        protectionSummary: protectionCategory == 'device_security_managed'
            ? '由设备安全设置保护'
            : '设备保护状态不可确认',
        applicationLayerEncryption: false,
        platformEncryptionStatus: 'not_exposed',
        backupPolicy: backupPolicy,
      );
    } catch (_) {
      return const DiagnosticDeviceProtection(
        storageScope: 'unknown',
        protectionCategory: 'unknown',
        protectionSummary: '设备保护状态不可确认',
        applicationLayerEncryption: false,
        platformEncryptionStatus: 'not_exposed',
        backupPolicy: 'unknown',
      );
    }
  }

  Future<DiagnosticTranscriptionSummary> _loadTranscriptionSummary() async {
    try {
      final db = await _database.database;
      final statusCounts = await _groupedCounts(
        db,
        column: 'status',
        normalize: (value) =>
            _knownStatuses.contains(value) ? value : 'unknown',
      );
      final stageCounts = await _groupedCounts(
        db,
        column: 'stage',
        normalize: (value) => _knownStages.contains(value) ? value : 'unknown',
      );
      final errorCounts = await _groupedCounts(
        db,
        column: 'error_code',
        where: 'error_code IS NOT NULL',
        normalize: (value) =>
            _safeErrorCategory.hasMatch(value) ? value : 'OTHER',
      );
      final timingRows = await db.rawQuery('''
        SELECT
          COUNT(*) AS job_count,
          CAST(AVG(completed_at_ms - started_at_ms) AS INTEGER)
            AS average_processing_ms,
          MAX(completed_at_ms - started_at_ms) AS maximum_processing_ms
        FROM transcription_jobs
        WHERE started_at_ms IS NOT NULL
          AND completed_at_ms IS NOT NULL
          AND completed_at_ms >= started_at_ms
      ''');
      final timing = timingRows.single;
      return DiagnosticTranscriptionSummary(
        statusCounts: statusCounts,
        stageCounts: stageCounts,
        errorCategoryCounts: errorCounts,
        timedJobCount: (timing['job_count'] as num?)?.toInt() ?? 0,
        averageProcessingMs:
            (timing['average_processing_ms'] as num?)?.toInt() ?? 0,
        maximumProcessingMs:
            (timing['maximum_processing_ms'] as num?)?.toInt() ?? 0,
      );
    } catch (_) {
      return const DiagnosticTranscriptionSummary(
        statusCounts: <String, int>{},
        stageCounts: <String, int>{},
        errorCategoryCounts: <String, int>{},
        timedJobCount: 0,
        averageProcessingMs: 0,
        maximumProcessingMs: 0,
      );
    }
  }

  Future<Map<String, int>> _groupedCounts(
    Database db, {
    required String column,
    required String Function(String value) normalize,
    String? where,
  }) async {
    final rows = await db.query(
      'transcription_jobs',
      columns: <String>[column, 'COUNT(*) AS item_count'],
      where: where,
      groupBy: column,
    );
    final result = <String, int>{};
    for (final row in rows) {
      final value = row[column] as String? ?? 'unknown';
      final category = normalize(value);
      result.update(
        category,
        (count) => count + (row['item_count'] as int? ?? 0),
        ifAbsent: () => row['item_count'] as int? ?? 0,
      );
    }
    return Map<String, int>.unmodifiable(result);
  }

  String _safeBuildValue(Object? value) {
    final text = value is String ? value : 'unknown';
    return _safeBuildToken.hasMatch(text) ? text : 'unknown';
  }
}
