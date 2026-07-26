import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

class AppDatabase {
  static final AppDatabase instance = AppDatabase._();
  AppDatabase._();
  AppDatabase.forTesting(Database database) : _db = database;

  Database? _db;

  Future<Database> get database async {
    if (_db != null) return _db!;
    _db = await _open();
    return _db!;
  }

  Future<Database> _open() async {
    final String dbPath = await getDatabasesPath();
    final String path = p.join(dbPath, 'voice2text_flutter.db');

    return openDatabase(
      path,
      version: 19,
      onConfigure: (Database db) async {
        await db.execute('PRAGMA foreign_keys = ON');
      },
      onCreate: (Database db, int version) async {
        await createCurrentSchema(db);
      },
      onUpgrade: (Database db, int oldVersion, int newVersion) async {
        if (oldVersion < 2) {
          await db.execute('''
            CREATE TABLE transcription_jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              recording_path TEXT NOT NULL,
              duration_ms INTEGER NOT NULL,
              status TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              result_text TEXT,
              error_message TEXT
            )
          ''');
        }

        if (oldVersion < 3) {
          await db.execute('''
            CREATE TABLE app_settings (
              id INTEGER PRIMARY KEY,
              model_id TEXT NOT NULL,
              auto_transcribe INTEGER NOT NULL,
              is_dark_mode INTEGER NOT NULL DEFAULT 0
            )
          ''');
        }

        if (oldVersion < 4) {
          await db.execute(
            'ALTER TABLE recordings ADD COLUMN display_name TEXT',
          );
        }

        if (oldVersion < 5) {
          await db.execute(
            'ALTER TABLE recordings ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0',
          );
        }

        if (oldVersion < 6) {
          await db.execute(
            'ALTER TABLE recordings ADD COLUMN deleted_at_ms INTEGER',
          );
        }

        if (oldVersion < 7) {
          await db.execute(
            'ALTER TABLE app_settings ADD COLUMN is_dark_mode INTEGER NOT NULL DEFAULT 0',
          );
        }

        if (oldVersion < 8) {
          await db.execute('ALTER TABLE recordings ADD COLUMN group_name TEXT');
          await db.execute('''
            CREATE TABLE IF NOT EXISTS folders (
              name TEXT PRIMARY KEY,
              created_at_ms INTEGER NOT NULL,
              is_favorite INTEGER NOT NULL DEFAULT 0
            )
          ''');
        }

        if (oldVersion < 9) {
          await db.execute(
            "ALTER TABLE app_settings ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'standard'",
          );
          await db.execute(
            "ALTER TABLE transcription_jobs ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'standard'",
          );
          await db.execute(
            "ALTER TABLE transcription_jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'standard_offline'",
          );
          await db.execute(
            'ALTER TABLE transcription_jobs ADD COLUMN failure_stage TEXT',
          );
          await db.execute(
            'ALTER TABLE transcription_jobs ADD COLUMN progress REAL',
          );
          await db.execute('''
            CREATE TABLE IF NOT EXISTS transcript_segments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              recording_path TEXT NOT NULL,
              job_id INTEGER,
              sequence_id INTEGER NOT NULL,
              text TEXT NOT NULL,
              start_ms INTEGER NOT NULL,
              end_ms INTEGER NOT NULL,
              is_final INTEGER NOT NULL DEFAULT 1,
              source TEXT NOT NULL,
              confidence REAL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              UNIQUE(recording_path, sequence_id)
            )
          ''');
        }

        if (oldVersion < 10) {
          await migrateRecordingSessions(db);
        }
        if (oldVersion < 11) {
          await migrateManagedMeetingAssets(db);
        }
        if (oldVersion < 12) {
          await migrateTranscriptionQueue(db);
        }
        if (oldVersion < 13) {
          await migrateTranscriptGenerations(db);
        }
        if (oldVersion < 14) {
          await migrateTranscriptRevisions(db);
        }
        if (oldVersion < 15) {
          await migrateMeetingIntelligence(db);
        }
        if (oldVersion < 16) {
          await migrateTranscriptReviewClosure(db);
        }
        if (oldVersion < 17) {
          await migrateRecordingAnnotations(db);
        }
        if (oldVersion < 18) {
          await migrateS2Closure(db);
        }
        if (oldVersion < 19) {
          await migrateS3Productization(db);
        }
      },
    );
  }

  static Future<void> createCurrentSchema(Database db) async {
    await db.execute('''
      CREATE TABLE recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        display_name TEXT,
        group_name TEXT,
        deleted_at_ms INTEGER,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        asset_kind TEXT NOT NULL DEFAULT 'recording',
        fingerprint_sha256 TEXT,
        source_display_name TEXT,
        deletion_state TEXT NOT NULL DEFAULT 'active',
        active_generation_id INTEGER,
        duration_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    ''');
    await db.execute(
      'CREATE UNIQUE INDEX recordings_session_id_unique '
      'ON recordings(session_id) WHERE session_id IS NOT NULL',
    );
    await db.execute('''
      CREATE TABLE transcription_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_path TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        recording_mode TEXT NOT NULL DEFAULT 'standard',
        source TEXT NOT NULL DEFAULT 'standard_offline',
        failure_stage TEXT,
        stage TEXT NOT NULL DEFAULT 'queued',
        progress REAL NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        dedupe_key TEXT,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        recording_id INTEGER,
        generation_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        result_text TEXT,
        error_message TEXT
      )
    ''');
    await db.execute('''
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY,
        model_id TEXT NOT NULL,
        recording_mode TEXT NOT NULL DEFAULT 'standard',
        auto_transcribe INTEGER NOT NULL,
        enable_punctuation INTEGER NOT NULL DEFAULT 1,
        is_dark_mode INTEGER NOT NULL DEFAULT 0,
        recording_consent_version INTEGER NOT NULL DEFAULT 0,
        recording_consent_accepted_at_ms INTEGER,
        recently_deleted_retention_days INTEGER
          CHECK (
            recently_deleted_retention_days IS NULL OR
            recently_deleted_retention_days IN (7, 30, 90)
          ),
        retention_last_successful_scan_at_ms INTEGER,
        meeting_processing_location TEXT NOT NULL DEFAULT 'onDevice'
          CHECK (
            meeting_processing_location IN (
              'onDevice', 'cloudDirect', 'pairedPc'
            )
          ),
        meeting_ai_provider_id TEXT,
        meeting_ai_model_id TEXT,
        meeting_ai_secret_configured INTEGER NOT NULL DEFAULT 0
      )
    ''');
    await db.execute('''
      CREATE TABLE folders (
        name TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0
      )
    ''');
    await _createRecordingSessionsSchema(db);
    await _createManagedMeetingAssetsSchema(db);
    await _createTranscriptionQueueIndexes(db);
    await _createTranscriptGenerationSchema(db);
    await _createTranscriptRevisionsSchema(db);
    await _createMeetingIntelligenceSchema(db);
    await _createSpeakerSchema(db);
    await _createTranscriptReviewClosureIndexes(db);
    await _createRecordingAnnotationsSchema(db);
  }

  static Future<void> migrateRecordingSessions(Database db) async {
    final recordingColumns = await db.rawQuery('PRAGMA table_info(recordings)');
    if (!recordingColumns.any((row) => row['name'] == 'session_id')) {
      await db.execute('ALTER TABLE recordings ADD COLUMN session_id TEXT');
    }
    await db.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS recordings_session_id_unique '
      'ON recordings(session_id) WHERE session_id IS NOT NULL',
    );

    final settingsColumns = await db.rawQuery(
      'PRAGMA table_info(app_settings)',
    );
    if (!settingsColumns.any(
      (row) => row['name'] == 'recording_consent_version',
    )) {
      await db.execute(
        'ALTER TABLE app_settings ADD COLUMN '
        'recording_consent_version INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!settingsColumns.any(
      (row) => row['name'] == 'recording_consent_accepted_at_ms',
    )) {
      await db.execute(
        'ALTER TABLE app_settings ADD COLUMN '
        'recording_consent_accepted_at_ms INTEGER',
      );
    }
    await _createRecordingSessionsSchema(db);
  }

  static Future<void> _createRecordingSessionsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS recording_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        staging_path TEXT,
        canonical_path TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT,
        error_category TEXT,
        native_created_at_ms INTEGER,
        native_updated_at_ms INTEGER,
        recording_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id)
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS recording_sessions_state_updated '
      'ON recording_sessions(state, updated_at_ms)',
    );
  }

  static Future<void> migrateRecordingAnnotations(Database db) async {
    await _createRecordingAnnotationsSchema(db);
  }

  static Future<void> migrateS2Closure(Database db) async {
    final settingsColumns = await db.rawQuery(
      'PRAGMA table_info(app_settings)',
    );
    final existing = settingsColumns.map((row) => row['name']).toSet();
    if (!existing.contains('recently_deleted_retention_days')) {
      await db.execute(
        'ALTER TABLE app_settings ADD COLUMN '
        'recently_deleted_retention_days INTEGER',
      );
    }
    if (!existing.contains('retention_last_successful_scan_at_ms')) {
      await db.execute(
        'ALTER TABLE app_settings ADD COLUMN '
        'retention_last_successful_scan_at_ms INTEGER',
      );
    }
  }

  static Future<void> _createRecordingAnnotationsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS recording_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('marker', 'note')),
        position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
        text TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (
          (kind = 'marker' AND text IS NULL) OR
          (kind = 'note' AND text IS NOT NULL AND length(trim(text)) > 0)
        ),
        FOREIGN KEY(session_id)
          REFERENCES recording_sessions(session_id)
          ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS recording_annotations_session_time '
      'ON recording_annotations(session_id, position_ms, id)',
    );
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS recording_annotations_single_note "
      "ON recording_annotations(session_id) WHERE kind = 'note'",
    );
  }

  static Future<void> migrateManagedMeetingAssets(Database db) async {
    final recordingColumns = await db.rawQuery('PRAGMA table_info(recordings)');
    final existing = recordingColumns.map((row) => row['name']).toSet();
    if (!existing.contains('asset_kind')) {
      await db.execute(
        "ALTER TABLE recordings ADD COLUMN asset_kind TEXT NOT NULL DEFAULT 'recording'",
      );
    }
    if (!existing.contains('fingerprint_sha256')) {
      await db.execute(
        'ALTER TABLE recordings ADD COLUMN fingerprint_sha256 TEXT',
      );
    }
    if (!existing.contains('source_display_name')) {
      await db.execute(
        'ALTER TABLE recordings ADD COLUMN source_display_name TEXT',
      );
    }
    if (!existing.contains('deletion_state')) {
      await db.execute(
        "ALTER TABLE recordings ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'",
      );
    }
    await db.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS recordings_fingerprint_unique '
      'ON recordings(fingerprint_sha256) WHERE fingerprint_sha256 IS NOT NULL',
    );
    await _createManagedMeetingAssetsSchema(db);
  }

  static Future<void> _createManagedMeetingAssetsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_assets_recording_id '
      'ON meeting_assets(recording_id)',
    );
  }

  static Future<void> migrateTranscriptionQueue(Database db) async {
    final columns = await db.rawQuery('PRAGMA table_info(transcription_jobs)');
    final existing = columns.map((row) => row['name']).toSet();
    final additions = <String, String>{
      'stage': "TEXT NOT NULL DEFAULT 'queued'",
      'attempt_count': 'INTEGER NOT NULL DEFAULT 0',
      'cancel_requested': 'INTEGER NOT NULL DEFAULT 0',
      'error_code': 'TEXT',
      'dedupe_key': 'TEXT',
      'started_at_ms': 'INTEGER',
      'completed_at_ms': 'INTEGER',
      'heartbeat_at_ms': 'INTEGER',
    };
    for (final entry in additions.entries) {
      if (!existing.contains(entry.key)) {
        await db.execute(
          'ALTER TABLE transcription_jobs ADD COLUMN '
          '${entry.key} ${entry.value}',
        );
      }
    }
    await db.execute(
      "UPDATE transcription_jobs "
      "SET dedupe_key = recording_path || '|' || source "
      'WHERE dedupe_key IS NULL',
    );
    await db.execute('''
      UPDATE transcription_jobs
      SET status = 'failed',
          failure_stage = 'persistence',
          error_code = 'DUPLICATE_QUEUE_JOB',
          error_message = '升级时合并了重复的活动任务',
          completed_at_ms = updated_at_ms
      WHERE status IN ('pending', 'processing')
        AND id NOT IN (
          SELECT MIN(id)
          FROM transcription_jobs
          WHERE status IN ('pending', 'processing')
          GROUP BY dedupe_key
        )
    ''');
    await _createTranscriptionQueueIndexes(db);
  }

  static Future<void> _createTranscriptionQueueIndexes(Database db) async {
    await db.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS transcription_jobs_active_key_unique '
      'ON transcription_jobs(dedupe_key) '
      "WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')",
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcription_jobs_claim_order '
      'ON transcription_jobs(status, cancel_requested, created_at_ms, id)',
    );
  }

  static Future<void> migrateTranscriptGenerations(Database db) async {
    final recordingColumns = await db.rawQuery('PRAGMA table_info(recordings)');
    if (!recordingColumns.any((row) => row['name'] == 'active_generation_id')) {
      await db.execute(
        'ALTER TABLE recordings ADD COLUMN active_generation_id INTEGER',
      );
    }

    final jobColumns = await db.rawQuery(
      'PRAGMA table_info(transcription_jobs)',
    );
    if (!jobColumns.any((row) => row['name'] == 'recording_id')) {
      await db.execute(
        'ALTER TABLE transcription_jobs ADD COLUMN recording_id INTEGER',
      );
    }
    if (!jobColumns.any((row) => row['name'] == 'generation_id')) {
      await db.execute(
        'ALTER TABLE transcription_jobs ADD COLUMN generation_id INTEGER',
      );
    }
    await db.execute('''
      UPDATE transcription_jobs
      SET recording_id = (
        SELECT recordings.id
        FROM recordings
        WHERE recordings.file_path = transcription_jobs.recording_path
        ORDER BY recordings.id ASC
        LIMIT 1
      )
      WHERE recording_id IS NULL
    ''');

    await _createTranscriptGenerationsTable(db);
    final segmentColumns = await db.rawQuery(
      'PRAGMA table_info(transcript_segments)',
    );
    if (segmentColumns.isEmpty) {
      await _createTranscriptSegmentsV13Table(db);
      await _createTranscriptGenerationIndexes(db);
      return;
    }
    if (segmentColumns.any((row) => row['name'] == 'generation_id')) {
      await _createTranscriptGenerationIndexes(db);
      return;
    }

    const legacyTable = 'transcript_segments_legacy_v13';
    await db.execute('ALTER TABLE transcript_segments RENAME TO $legacyTable');
    await _createTranscriptSegmentsV13Table(db);
    final paths = await db.rawQuery(
      'SELECT DISTINCT recording_path FROM $legacyTable '
      'ORDER BY recording_path ASC',
    );
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final pathRow in paths) {
      final path = pathRow['recording_path'] as String;
      final recordings = await db.query(
        'recordings',
        columns: <String>['id'],
        where: 'file_path = ?',
        whereArgs: <Object>[path],
        orderBy: 'id ASC',
        limit: 1,
      );
      final recordingId = recordings.isEmpty
          ? null
          : recordings.single['id'] as int;
      final legacySegments = await db.query(
        legacyTable,
        where: 'recording_path = ?',
        whereArgs: <Object>[path],
        orderBy: 'sequence_id ASC, start_ms ASC, id ASC',
      );
      final mergedText = legacySegments
          .map((segment) => (segment['text'] as String).trim())
          .where((text) => text.isNotEmpty)
          .join(' ');
      int? jobId;
      for (final segment in legacySegments) {
        final candidateJobId = segment['job_id'] as int?;
        if (candidateJobId != null) {
          final matchingJobs = await db.query(
            'transcription_jobs',
            columns: <String>['id'],
            where: 'id = ?',
            whereArgs: <Object>[candidateJobId],
            limit: 1,
          );
          if (matchingJobs.isNotEmpty) {
            jobId = candidateJobId;
            break;
          }
        }
      }
      final generationId = await db
          .insert('transcript_generations', <String, Object?>{
            'recording_id': recordingId,
            'recording_path': path,
            'job_id': jobId,
            'status': recordingId == null ? 'orphaned' : 'active',
            'source': 'legacy',
            'merged_text': mergedText,
            'has_user_edits': 0,
            'has_evidence_links': 0,
            'created_at_ms': now,
            'activated_at_ms': recordingId == null ? null : now,
            'updated_at_ms': now,
          });
      for (final segment in legacySegments) {
        await db.insert('transcript_segments', <String, Object?>{
          'recording_id': recordingId,
          'recording_path': path,
          'generation_id': generationId,
          'job_id': segment['job_id'] == jobId ? jobId : null,
          'sequence_id': segment['sequence_id'],
          'text': segment['text'],
          'start_ms': segment['start_ms'],
          'end_ms': segment['end_ms'],
          'is_final': segment['is_final'],
          'source': segment['source'],
          'confidence': segment['confidence'],
          'created_at_ms': segment['created_at_ms'],
          'updated_at_ms': segment['updated_at_ms'],
        });
      }
      if (recordingId != null) {
        await db.update(
          'recordings',
          <String, Object?>{'active_generation_id': generationId},
          where: 'id = ?',
          whereArgs: <Object>[recordingId],
        );
      }
    }
    await db.execute('DROP TABLE $legacyTable');
    await _createTranscriptGenerationIndexes(db);
  }

  static Future<void> _createTranscriptGenerationSchema(Database db) async {
    await _createTranscriptGenerationsTable(db);
    await _createTranscriptSegmentsV13Table(db);
    await _createTranscriptGenerationIndexes(db);
  }

  static Future<void> _createTranscriptGenerationsTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS transcript_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER,
        recording_path TEXT NOT NULL,
        job_id INTEGER,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        merged_text TEXT NOT NULL,
        has_user_edits INTEGER NOT NULL DEFAULT 0,
        has_evidence_links INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        activated_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(job_id) REFERENCES transcription_jobs(id) ON DELETE SET NULL
      )
    ''');
  }

  static Future<void> _createTranscriptSegmentsV13Table(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER,
        recording_path TEXT NOT NULL,
        generation_id INTEGER NOT NULL,
        job_id INTEGER,
        sequence_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        is_final INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        confidence REAL,
        review_state TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_state IN ('unreviewed', 'needs_review', 'reviewed')),
        reviewed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(generation_id, sequence_id),
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(job_id) REFERENCES transcription_jobs(id) ON DELETE SET NULL
      )
    ''');
  }

  static Future<void> _createTranscriptGenerationIndexes(Database db) async {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_generations_recording_status '
      'ON transcript_generations(recording_id, status, id)',
    );
    await db.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS transcript_generations_job_unique '
      'ON transcript_generations(job_id) WHERE job_id IS NOT NULL',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_segments_generation_order '
      'ON transcript_segments(generation_id, sequence_id, start_ms, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_segments_recording_time '
      'ON transcript_segments(recording_id, start_ms, end_ms, id)',
    );
  }

  static Future<void> migrateTranscriptRevisions(Database db) async {
    await _createTranscriptRevisionsSchema(db);
  }

  static Future<void> _createTranscriptRevisionsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS transcript_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        segment_id INTEGER NOT NULL,
        previous_text TEXT NOT NULL,
        next_text TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        reverted_at_ms INTEGER,
        invalidated_at_ms INTEGER,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_revisions_segment_order '
      'ON transcript_revisions(segment_id, created_at_ms DESC, id DESC)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_revisions_generation_order '
      'ON transcript_revisions(generation_id, created_at_ms DESC, id DESC)',
    );
  }

  static Future<void> migrateMeetingIntelligence(Database db) async {
    await _createMeetingIntelligenceSchema(db);
  }

  static Future<void> migrateS3Productization(Database db) async {
    await _addColumnIfMissing(
      db,
      table: 'app_settings',
      column: 'meeting_processing_location',
      definition:
          "TEXT NOT NULL DEFAULT 'onDevice' "
          "CHECK (meeting_processing_location IN "
          "('onDevice', 'cloudDirect', 'pairedPc'))",
    );
    await _addColumnIfMissing(
      db,
      table: 'app_settings',
      column: 'meeting_ai_provider_id',
      definition: 'TEXT',
    );
    await _addColumnIfMissing(
      db,
      table: 'app_settings',
      column: 'meeting_ai_model_id',
      definition: 'TEXT',
    );
    await _addColumnIfMissing(
      db,
      table: 'app_settings',
      column: 'meeting_ai_secret_configured',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    );

    await _createMeetingIntelligenceJobsSchema(db);
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'job_id',
      definition:
          'INTEGER REFERENCES meeting_intelligence_jobs(id) '
          'ON DELETE SET NULL',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'output_schema_version',
      definition: "TEXT NOT NULL DEFAULT 'meeting_intelligence_output/v1'",
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'template_id',
      definition: "TEXT NOT NULL DEFAULT 'general'",
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'meeting_type',
      definition: 'TEXT',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'suggested_title',
      definition: 'TEXT',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'consent_version',
      definition: 'INTEGER NOT NULL DEFAULT 1',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'consent_at_ms',
      definition: 'INTEGER',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_notes',
      column: 'payload_summary',
      definition: 'TEXT',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_insights',
      column: 'resolution_state',
      definition:
          "TEXT NOT NULL DEFAULT 'notApplicable' "
          "CHECK (resolution_state IN "
          "('notApplicable', 'open', 'resolved'))",
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_insights',
      column: 'topic_start_ms',
      definition: 'INTEGER',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_insights',
      column: 'topic_end_ms',
      definition: 'INTEGER',
    );
    await _addColumnIfMissing(
      db,
      table: 'meeting_insights',
      column: 'sort_order',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute(
      "UPDATE meeting_notes SET processing_location = 'onDevice' "
      "WHERE processing_location = 'local'",
    );
    await db.execute(
      "UPDATE meeting_notes SET processing_location = 'cloudDirect' "
      "WHERE processing_location = 'remote'",
    );
    await _createMeetingIntelligenceIndexes(db);
    await _createSpeakerSchema(db);
  }

  static Future<void> migrateTranscriptReviewClosure(Database db) async {
    final settingsColumns = await db.rawQuery(
      'PRAGMA table_info(app_settings)',
    );
    if (!settingsColumns.any((row) => row['name'] == 'enable_punctuation')) {
      await db.execute(
        'ALTER TABLE app_settings ADD COLUMN '
        'enable_punctuation INTEGER NOT NULL DEFAULT 1',
      );
    }

    final segmentColumns = await db.rawQuery(
      'PRAGMA table_info(transcript_segments)',
    );
    if (!segmentColumns.any((row) => row['name'] == 'review_state')) {
      await db.execute(
        'ALTER TABLE transcript_segments ADD COLUMN '
        "review_state TEXT NOT NULL DEFAULT 'unreviewed' "
        "CHECK (review_state IN ('unreviewed', 'needs_review', 'reviewed'))",
      );
    }
    if (!segmentColumns.any((row) => row['name'] == 'reviewed_at_ms')) {
      await db.execute(
        'ALTER TABLE transcript_segments ADD COLUMN reviewed_at_ms INTEGER',
      );
    }

    final revisionColumns = await db.rawQuery(
      'PRAGMA table_info(transcript_revisions)',
    );
    if (!revisionColumns.any((row) => row['name'] == 'invalidated_at_ms')) {
      await db.execute(
        'ALTER TABLE transcript_revisions ADD COLUMN '
        'invalidated_at_ms INTEGER',
      );
    }
    await _createTranscriptReviewClosureIndexes(db);
  }

  static Future<void> _createTranscriptReviewClosureIndexes(Database db) async {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_segments_review_time '
      'ON transcript_segments('
      'generation_id, review_state, start_ms, end_ms, id'
      ')',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_revisions_redo_order '
      'ON transcript_revisions('
      'generation_id, invalidated_at_ms, reverted_at_ms DESC, id DESC'
      ')',
    );
  }

  static Future<void> _createMeetingIntelligenceSchema(Database db) async {
    await _createMeetingIntelligenceJobsSchema(db);
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        job_id INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        processing_location TEXT NOT NULL,
        consent_granted INTEGER NOT NULL,
        consent_version INTEGER NOT NULL DEFAULT 1,
        consent_at_ms INTEGER,
        payload_summary TEXT,
        input_start_ms INTEGER NOT NULL,
        input_end_ms INTEGER NOT NULL,
        output_schema_version TEXT NOT NULL
          DEFAULT 'meeting_intelligence_output/v1',
        template_id TEXT NOT NULL DEFAULT 'general',
        meeting_type TEXT,
        suggested_title TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        reviewed_at_ms INTEGER,
        published_at_ms INTEGER,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(job_id) REFERENCES meeting_intelligence_jobs(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        action_owner TEXT,
        action_due_at_ms INTEGER,
        unresolved_owner INTEGER NOT NULL DEFAULT 0,
        unresolved_due_date INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        unsupported INTEGER NOT NULL DEFAULT 0,
        resolution_state TEXT NOT NULL DEFAULT 'notApplicable'
          CHECK (
            resolution_state IN ('notApplicable', 'open', 'resolved')
          ),
        topic_start_ms INTEGER,
        topic_end_ms INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        reviewed_at_ms INTEGER,
        rejected_at_ms INTEGER,
        published_at_ms INTEGER,
        FOREIGN KEY(note_id) REFERENCES meeting_notes(id) ON DELETE CASCADE
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS evidence_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        insight_id INTEGER NOT NULL,
        segment_id INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(insight_id) REFERENCES meeting_insights(id) ON DELETE CASCADE,
        FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE,
        UNIQUE(insight_id, segment_id, start_ms, end_ms)
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_note_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        insight_id INTEGER,
        previous_body TEXT NOT NULL,
        next_body TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(note_id) REFERENCES meeting_notes(id) ON DELETE CASCADE,
        FOREIGN KEY(insight_id) REFERENCES meeting_insights(id) ON DELETE SET NULL
      )
    ''');
    await _createMeetingIntelligenceIndexes(db);
  }

  static Future<void> _createMeetingIntelligenceJobsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_intelligence_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        processing_location TEXT NOT NULL
          CHECK (
            processing_location IN (
              'onDevice', 'cloudDirect', 'pairedPc'
            )
          ),
        template_id TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (
            status IN (
              'queued', 'processing', 'completed', 'failed',
              'canceled', 'recoveryUnknown'
            )
          ),
        progress REAL NOT NULL DEFAULT 0
          CHECK (progress >= 0 AND progress <= 1),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        dedupe_key TEXT NOT NULL,
        input_start_ms INTEGER NOT NULL,
        input_end_ms INTEGER NOT NULL,
        segment_count INTEGER NOT NULL DEFAULT 0,
        estimated_request_count INTEGER NOT NULL DEFAULT 1,
        speaker_labels_included INTEGER NOT NULL DEFAULT 0,
        consent_version INTEGER NOT NULL DEFAULT 1,
        consent_at_ms INTEGER,
        payload_summary TEXT,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        UNIQUE(dedupe_key)
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_intelligence_jobs_recording_status '
      'ON meeting_intelligence_jobs(recording_id, status, created_at_ms, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_intelligence_jobs_generation_status '
      'ON meeting_intelligence_jobs(generation_id, status, id)',
    );
  }

  static Future<void> _createMeetingIntelligenceIndexes(Database db) async {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_notes_recording_order '
      'ON meeting_notes(recording_id, created_at_ms DESC, id DESC)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_insights_note_status '
      'ON meeting_insights(note_id, status, kind, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS evidence_links_insight '
      'ON evidence_links(insight_id, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS evidence_links_segment '
      'ON evidence_links(segment_id, insight_id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_note_revisions_note_order '
      'ON meeting_note_revisions(note_id, created_at_ms DESC, id DESC)',
    );
  }

  static Future<void> _createSpeakerSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS meeting_speakers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        stable_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'automatic',
        merged_into_speaker_id INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(generation_id, stable_key),
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(merged_into_speaker_id)
          REFERENCES meeting_speakers(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS speaker_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        speaker_id INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'automatic',
        confidence REAL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (start_ms >= 0 AND end_ms > start_ms),
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(speaker_id) REFERENCES meeting_speakers(id) ON DELETE CASCADE
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS transcript_speaker_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        segment_id INTEGER NOT NULL,
        speaker_id INTEGER,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('assigned', 'overlap', 'unknown')),
        source TEXT NOT NULL DEFAULT 'automatic',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (start_ms >= 0 AND end_ms > start_ms),
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE,
        FOREIGN KEY(speaker_id) REFERENCES meeting_speakers(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS speaker_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        generation_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        previous_payload_json TEXT NOT NULL,
        next_payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        reverted_at_ms INTEGER,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS meeting_speakers_generation_order '
      'ON meeting_speakers(generation_id, merged_into_speaker_id, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS speaker_turns_generation_time '
      'ON speaker_turns(generation_id, start_ms, end_ms, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_speaker_assignments_segment_time '
      'ON transcript_speaker_assignments('
      'segment_id, start_ms, end_ms, id'
      ')',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS speaker_revisions_generation_order '
      'ON speaker_revisions(generation_id, created_at_ms DESC, id DESC)',
    );
  }

  static Future<void> _addColumnIfMissing(
    Database db, {
    required String table,
    required String column,
    required String definition,
  }) async {
    final columns = await db.rawQuery('PRAGMA table_info($table)');
    if (!columns.any((row) => row['name'] == column)) {
      await db.execute('ALTER TABLE $table ADD COLUMN $column $definition');
    }
  }
}
