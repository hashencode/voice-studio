import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:sqflite/sqflite.dart';

class DesktopMeetingAiRun {
  const DesktopMeetingAiRun({
    required this.jobId,
    required this.noteId,
    required this.output,
  });

  final int jobId;
  final int noteId;
  final MeetingAiOutput output;
}

class DesktopMeetingAiRepository {
  DesktopMeetingAiRepository({
    required AppDatabase database,
    required MeetingAiWorkflow workflow,
    required MeetingAiProviderPort provider,
  }) : _database = database,
       _providerResolver = _LegacyProviderResolver(provider).call,
       _legacyWorkflow = workflow;

  const DesktopMeetingAiRepository.withProviderResolver({
    required AppDatabase database,
    required Future<MeetingAiProviderPort> Function() providerResolver,
  }) : _database = database,
       _providerResolver = providerResolver,
       _legacyWorkflow = null;

  final AppDatabase _database;
  final Future<MeetingAiProviderPort> Function() _providerResolver;
  final MeetingAiWorkflow? _legacyWorkflow;

  Future<int> reconcileInterrupted() async {
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    return database.update('meeting_intelligence_jobs', <String, Object?>{
      'status': 'recoveryUnknown',
      'error_code': 'AI_PROCESS_INTERRUPTED',
      'updated_at_ms': now,
    }, where: "status = 'processing'");
  }

  Future<DesktopMeetingAiRun> generate(MeetingAiRequest request) async {
    final provider = await _providerResolver();
    final descriptor = meetingAiDescriptorOf(provider);
    if (descriptor.requiresMeetingConsent &&
        request.consent != MeetingAiConsent.granted) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.consentRequired,
        '需要针对本次会议明确同意发送转写文本',
      );
    }
    if (request.recordingId <= 0 ||
        request.generationId <= 0 ||
        request.segments.isEmpty) {
      throw const MeetingAiFailure(
        MeetingAiFailureCode.invalidOutput,
        '会议转写尚未准备好',
      );
    }
    final database = await _database.database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final dedupe = sha256
        .convert(
          utf8.encode(
            '${request.recordingId}|${request.generationId}|'
            '${provider.providerId}|${provider.modelId}|'
            '${request.templateId}|$now',
          ),
        )
        .toString();
    final jobId = await database.insert('meeting_intelligence_jobs', <
      String,
      Object?
    >{
      'recording_id': request.recordingId,
      'generation_id': request.generationId,
      'provider_id': provider.providerId,
      'model_id': provider.modelId,
      'processing_location': _storageLocation(descriptor),
      'template_id': request.templateId,
      'status': 'queued',
      'progress': 0.0,
      'attempt_count': 0,
      'cancel_requested': 0,
      'error_code': null,
      'dedupe_key': dedupe,
      'input_start_ms': request.segments.first.startMs,
      'input_end_ms': request.segments.last.endMs,
      'segment_count': request.segments.length,
      'estimated_request_count': 1,
      'speaker_labels_included': 0,
      'consent_version': descriptor.requiresMeetingConsent ? 1 : 0,
      'consent_at_ms': descriptor.requiresMeetingConsent ? now : null,
      'payload_summary':
          '${request.segments.length} segments, '
          '${request.segments.fold<int>(0, (sum, item) => sum + item.text.length)} chars',
      'started_at_ms': null,
      'completed_at_ms': null,
      'heartbeat_at_ms': null,
      'created_at_ms': now,
      'updated_at_ms': now,
    });
    await database.update(
      'meeting_intelligence_jobs',
      <String, Object?>{
        'status': 'processing',
        'progress': 0.1,
        'attempt_count': 1,
        'started_at_ms': now,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[jobId],
    );
    try {
      final workflow = _legacyWorkflow ?? MeetingAiWorkflow(provider: provider);
      final output = await workflow.generate(request);
      final noteId = await database.transaction<int>((transaction) async {
        final completedAt = DateTime.now().millisecondsSinceEpoch;
        final noteId = await transaction
            .insert('meeting_notes', <String, Object?>{
              'recording_id': request.recordingId,
              'generation_id': request.generationId,
              'job_id': jobId,
              'status': 'draft',
              'provider_id': provider.providerId,
              'model_id': provider.modelId,
              'processing_location': _storageLocation(descriptor),
              'consent_granted': descriptor.requiresMeetingConsent ? 1 : 0,
              'consent_version': descriptor.requiresMeetingConsent ? 1 : 0,
              'consent_at_ms': descriptor.requiresMeetingConsent ? now : null,
              'payload_summary':
                  '${request.segments.length} segments, speaker labels omitted',
              'input_start_ms': request.segments.first.startMs,
              'input_end_ms': request.segments.last.endMs,
              'output_schema_version': output.schemaVersion,
              'template_id': request.templateId,
              'meeting_type': output.meetingType,
              'suggested_title': output.suggestedTitle,
              'created_at_ms': completedAt,
              'updated_at_ms': completedAt,
              'reviewed_at_ms': null,
              'published_at_ms': null,
            });
        for (var index = 0; index < output.insights.length; index += 1) {
          final insight = output.insights[index];
          final insightId = await transaction
              .insert('meeting_insights', <String, Object?>{
                'note_id': noteId,
                'kind': insight.kind,
                'body': insight.body,
                'action_owner': insight.actionOwner,
                'action_due_at_ms': insight.actionDueAtMs,
                'unresolved_owner': insight.actionOwner == null ? 1 : 0,
                'unresolved_due_date': insight.actionDueAtMs == null ? 1 : 0,
                'status': 'draft',
                'unsupported': 0,
                'resolution_state': 'notApplicable',
                'topic_start_ms': insight.evidence.isEmpty
                    ? null
                    : insight.evidence.first.startMs,
                'topic_end_ms': insight.evidence.isEmpty
                    ? null
                    : insight.evidence.last.endMs,
                'sort_order': index,
                'created_at_ms': completedAt,
                'updated_at_ms': completedAt,
                'reviewed_at_ms': null,
                'rejected_at_ms': null,
                'published_at_ms': null,
              });
          for (final evidence in insight.evidence) {
            await transaction.insert('evidence_links', <String, Object?>{
              'insight_id': insightId,
              'segment_id': evidence.segmentId,
              'start_ms': evidence.startMs,
              'end_ms': evidence.endMs,
              'created_at_ms': completedAt,
            });
          }
        }
        await transaction.update(
          'meeting_intelligence_jobs',
          <String, Object?>{
            'status': 'completed',
            'progress': 1.0,
            'completed_at_ms': completedAt,
            'heartbeat_at_ms': completedAt,
            'updated_at_ms': completedAt,
          },
          where: 'id = ?',
          whereArgs: <Object>[jobId],
        );
        await transaction.update(
          'transcript_generations',
          <String, Object?>{
            'has_evidence_links':
                output.insights.any((item) => item.evidence.isNotEmpty) ? 1 : 0,
            'updated_at_ms': completedAt,
          },
          where: 'id = ?',
          whereArgs: <Object>[request.generationId],
        );
        return noteId;
      });
      return DesktopMeetingAiRun(jobId: jobId, noteId: noteId, output: output);
    } on MeetingAiFailure catch (failure) {
      await _markFailed(database, jobId, failure.code.name);
      rethrow;
    } on Object {
      await _markFailed(database, jobId, 'serviceUnavailable');
      rethrow;
    }
  }

  Future<bool> reviewInsight({
    required int insightId,
    required String body,
    required bool publish,
  }) async {
    final normalized = body.trim();
    if (normalized.isEmpty) throw ArgumentError.value(body);
    final database = await _database.database;
    return database.transaction<bool>((transaction) async {
      final rows = await transaction.query(
        'meeting_insights',
        where: 'id = ?',
        whereArgs: <Object>[insightId],
        limit: 1,
      );
      if (rows.isEmpty) return false;
      final row = rows.single;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (row['body'] != normalized) {
        await transaction.insert('meeting_note_revisions', <String, Object?>{
          'note_id': row['note_id'],
          'insight_id': insightId,
          'previous_body': row['body'],
          'next_body': normalized,
          'action': 'edit',
          'created_at_ms': now,
        });
      }
      await transaction.update(
        'meeting_insights',
        <String, Object?>{
          'body': normalized,
          'status': publish ? 'published' : 'reviewed',
          'reviewed_at_ms': now,
          'published_at_ms': publish ? now : null,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[insightId],
      );
      await transaction.update(
        'meeting_notes',
        <String, Object?>{
          'status': publish ? 'published' : 'reviewed',
          'reviewed_at_ms': now,
          'published_at_ms': publish ? now : null,
          'updated_at_ms': now,
        },
        where: 'id = ?',
        whereArgs: <Object>[row['note_id']!],
      );
      return true;
    });
  }

  Future<void> _markFailed(Database database, int jobId, String code) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await database.update(
      'meeting_intelligence_jobs',
      <String, Object?>{
        'status': 'failed',
        'error_code': code,
        'heartbeat_at_ms': now,
        'updated_at_ms': now,
      },
      where: 'id = ?',
      whereArgs: <Object>[jobId],
    );
  }

  String _storageLocation(MeetingAiProviderDescriptor descriptor) {
    return descriptor.processingLocation ==
            MeetingAiProcessingLocation.localEndpoint
        ? 'onDevice'
        : 'cloudDirect';
  }
}

class _LegacyProviderResolver {
  const _LegacyProviderResolver(this.provider);

  final MeetingAiProviderPort provider;

  Future<MeetingAiProviderPort> call() async => provider;
}
