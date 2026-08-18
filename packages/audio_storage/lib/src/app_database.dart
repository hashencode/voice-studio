import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import 'audio_storage_contract.dart';

class AppDatabase {
  static const _retiredArchiveMarkerName = '.retired-source-pending.json';
  static final AppDatabase instance = AppDatabase();

  AppDatabase({
    DatabaseFactory? factory,
    Future<String> Function()? databasePathProvider,
    this.databaseName = AudioStorageContract.databaseFileName,
  }) : _factory = factory,
       _databasePathProvider = databasePathProvider;

  AppDatabase.forTesting(Database database)
    : _factory = null,
      _databasePathProvider = null,
      databaseName = AudioStorageContract.databaseFileName,
      _db = database;

  static const int schemaVersion = AudioStorageContract.schemaVersion;

  final DatabaseFactory? _factory;
  final Future<String> Function()? _databasePathProvider;
  final String databaseName;
  Database? _db;

  Future<Database> get database async {
    if (_db != null) return _db!;
    _db = await _open();
    return _db!;
  }

  Future<Database> _open() async {
    final String dbPath = await (_databasePathProvider ?? getDatabasesPath)();
    final String path = p.join(dbPath, databaseName);
    final DatabaseFactory factory = _factory ?? databaseFactory;

    if (databaseName == AudioStorageContract.databaseFileName) {
      await _archiveRetiredDatabase(dbPath);
    }

    return factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: schemaVersion,
        onConfigure: (Database db) async {
          await db.execute('PRAGMA foreign_keys = ON');
        },
        onCreate: (Database db, int version) async {
          await createCurrentSchema(db);
        },
      ),
    );
  }

  static Future<void> _archiveRetiredDatabase(String databasePath) async {
    final retiredPath = p.join(
      databasePath,
      AudioStorageContract.retiredDatabaseFileName,
    );
    final retiredDatabase = File(retiredPath);
    if (!await retiredDatabase.exists()) return;

    final archiveRoot = Directory(
      p.join(databasePath, AudioStorageContract.archiveDirectoryName),
    );
    await archiveRoot.create(recursive: true);
    if (await _discardVerifiedRetiredSource(retiredPath, archiveRoot)) return;

    final timestamp = DateTime.now().toUtc().microsecondsSinceEpoch;
    var suffix = 0;
    late Directory stagingDirectory;
    late Directory archiveDirectory;
    while (true) {
      final archiveName = suffix == 0 ? '$timestamp' : '$timestamp-$suffix';
      stagingDirectory = Directory(
        p.join(archiveRoot.path, '.$archiveName.staging'),
      );
      archiveDirectory = Directory(p.join(archiveRoot.path, archiveName));
      if (!await stagingDirectory.exists() &&
          !await archiveDirectory.exists()) {
        break;
      }
      suffix += 1;
    }

    final artifacts = <File>[
      retiredDatabase,
      File('$retiredPath-wal'),
      File('$retiredPath-shm'),
      File('$retiredPath-journal'),
    ];
    final copied = <Map<String, Object?>>[];
    await stagingDirectory.create();
    try {
      for (final artifact in artifacts) {
        if (await artifact.exists()) {
          final destination = File(
            p.join(stagingDirectory.path, p.basename(artifact.path)),
          );
          await artifact.copy(destination.path);
          await _flushFile(destination);
          final fingerprint = await _fingerprint(destination);
          if (!await _matchesFingerprint(artifact, fingerprint)) {
            throw FileSystemException(
              'Retired database archive verification failed',
              artifact.path,
            );
          }
          copied.add(<String, Object?>{
            'name': p.basename(artifact.path),
            ...fingerprint,
          });
        }
      }
      await stagingDirectory.rename(archiveDirectory.path);
      await _writeArchiveMarker(archiveRoot, archiveDirectory, copied);
    } catch (_) {
      try {
        if (await stagingDirectory.exists()) {
          await stagingDirectory.delete(recursive: true);
        }
      } catch (_) {
        // Best effort only: source artifacts remain authoritative on failure.
      }
      rethrow;
    }
  }

  static Future<bool> _discardVerifiedRetiredSource(
    String retiredPath,
    Directory archiveRoot,
  ) async {
    final marker = File(p.join(archiveRoot.path, _retiredArchiveMarkerName));
    if (!await marker.exists()) return false;
    final decoded = jsonDecode(await marker.readAsString());
    if (decoded is! Map<String, Object?>) {
      throw const FormatException('Retired database archive marker is invalid');
    }
    final archiveName = decoded['archiveName'];
    final copied = decoded['files'];
    if (archiveName is! String ||
        !RegExp(r'^\d+(?:-\d+)?$').hasMatch(archiveName) ||
        copied is! List ||
        copied.isEmpty ||
        copied.length > 4) {
      throw const FormatException('Retired database archive marker is invalid');
    }
    const databaseName = AudioStorageContract.retiredDatabaseFileName;
    const allowedNames = <String>{
      databaseName,
      '$databaseName-wal',
      '$databaseName-shm',
      '$databaseName-journal',
    };
    final names = <String>{};
    final verifiedSources = <MapEntry<File, String>>[];
    for (final value in copied) {
      if (value is! Map<String, Object?> ||
          value['name'] is! String ||
          value['sizeBytes'] is! int ||
          (value['sizeBytes'] as int) < 0 ||
          value['sha256'] is! String ||
          !RegExp(r'^[0-9a-f]{64}$').hasMatch(value['sha256'] as String)) {
        throw const FormatException(
          'Retired database archive marker is invalid',
        );
      }
      final name = value['name'] as String;
      if (!allowedNames.contains(name) || !names.add(name)) {
        throw const FormatException(
          'Retired database archive marker is invalid',
        );
      }
      final source = File('$retiredPath${_retiredSuffix(name)}');
      final archived = File(p.join(archiveRoot.path, archiveName, name));
      final expected = <String, Object>{
        'sizeBytes': value['sizeBytes'] as int,
        'sha256': value['sha256'] as String,
      };
      if (!await _matchesFingerprint(archived, expected) ||
          (await source.exists() &&
              !await _matchesFingerprint(source, expected))) {
        throw FileSystemException(
          'Retired database archive verification failed',
          source.path,
        );
      }
      if (await source.exists()) verifiedSources.add(MapEntry(source, name));
    }
    if (!names.contains(databaseName)) {
      throw const FormatException('Retired database archive marker is invalid');
    }
    verifiedSources.sort((left, right) {
      final leftIsDatabase = _retiredSuffix(left.value).isEmpty;
      final rightIsDatabase = _retiredSuffix(right.value).isEmpty;
      if (leftIsDatabase == rightIsDatabase) return 0;
      return leftIsDatabase ? 1 : -1;
    });
    for (final source in verifiedSources) {
      await source.key.delete();
    }
    await marker.delete();
    return true;
  }

  static String _retiredSuffix(String name) {
    const databaseName = AudioStorageContract.retiredDatabaseFileName;
    if (!name.startsWith(databaseName)) {
      throw const FormatException('Retired database archive marker is invalid');
    }
    return name.substring(databaseName.length);
  }

  static Future<void> _writeArchiveMarker(
    Directory archiveRoot,
    Directory archiveDirectory,
    List<Map<String, Object?>> copied,
  ) async {
    final marker = File(p.join(archiveRoot.path, _retiredArchiveMarkerName));
    final temporary = File('${marker.path}.tmp');
    await temporary.writeAsString(
      jsonEncode(<String, Object?>{
        'archiveName': p.basename(archiveDirectory.path),
        'files': copied,
      }),
      flush: true,
    );
    await temporary.rename(marker.path);
  }

  static Future<void> _flushFile(File file) async {
    final handle = await file.open(mode: FileMode.append);
    try {
      await handle.flush();
    } finally {
      await handle.close();
    }
  }

  static Future<Map<String, Object>> _fingerprint(File file) async {
    final stat = await file.stat();
    if (stat.type != FileSystemEntityType.file) {
      throw FileSystemException(
        'Expected a regular retired database file',
        file.path,
      );
    }
    final digest = await sha256.bind(file.openRead()).first;
    return <String, Object>{
      'sizeBytes': stat.size,
      'sha256': digest.toString(),
    };
  }

  static Future<bool> _matchesFingerprint(
    File file,
    Map<String, Object> expected,
  ) async {
    final actual = await _fingerprint(file);
    return actual['sizeBytes'] == expected['sizeBytes'] &&
        actual['sha256'] == expected['sha256'];
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
        audio_processing_location TEXT NOT NULL DEFAULT 'onDevice'
          CHECK (
            audio_processing_location IN (
              'onDevice', 'cloudDirect', 'pairedPc'
            )
          ),
        audio_ai_provider_id TEXT,
        audio_ai_model_id TEXT,
        audio_ai_endpoint TEXT,
        audio_ai_secret_configured INTEGER NOT NULL DEFAULT 0
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
    await _createManagedAudioAssetsSchema(db);
    await _createTranscriptionQueueIndexes(db);
    await _createTranscriptGenerationSchema(db);
    await _createTranscriptRevisionsSchema(db);
    await _createAudioIntelligenceSchema(db);
    await _createSpeakerSchema(db);
    await _createCompanionMediaTransferSchema(db);
    await _createDesktopCaptureSchema(db);
    await _createDesktopLiveCaptionSchema(db);
    await _createTranscriptReviewClosureIndexes(db);
    await _createRecordingAnnotationsSchema(db);
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

  static Future<void> _createManagedAudioAssetsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS audio_assets_recording_id '
      'ON audio_assets(recording_id)',
    );
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
        generation_kind TEXT NOT NULL DEFAULT 'formal'
          CHECK (generation_kind IN ('draft', 'formal')),
        supersedes_generation_id INTEGER,
        reconciliation_state TEXT NOT NULL DEFAULT 'not_required'
          CHECK (
            reconciliation_state IN (
              'not_required', 'pending', 'kept_draft', 'accepted_formal'
            )
          ),
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
        language TEXT,
        model_sha256 TEXT
          CHECK (model_sha256 IS NULL OR length(model_sha256) = 64),
        caption_session_id TEXT,
        worker_offset_bytes INTEGER
          CHECK (worker_offset_bytes IS NULL OR worker_offset_bytes >= 0),
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

  static Future<void> _createAudioIntelligenceSchema(Database db) async {
    await _createAudioIntelligenceJobsSchema(db);
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_notes (
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
          DEFAULT 'audio_intelligence_output/v1',
        template_id TEXT NOT NULL DEFAULT 'general',
        audio_type TEXT,
        suggested_title TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        reviewed_at_ms INTEGER,
        published_at_ms INTEGER,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE,
        FOREIGN KEY(generation_id) REFERENCES transcript_generations(id) ON DELETE CASCADE,
        FOREIGN KEY(job_id) REFERENCES audio_intelligence_jobs(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_insights (
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
        FOREIGN KEY(note_id) REFERENCES audio_notes(id) ON DELETE CASCADE
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
        FOREIGN KEY(insight_id) REFERENCES audio_insights(id) ON DELETE CASCADE,
        FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE,
        UNIQUE(insight_id, segment_id, start_ms, end_ms)
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_note_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL,
        insight_id INTEGER,
        previous_body TEXT NOT NULL,
        next_body TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(note_id) REFERENCES audio_notes(id) ON DELETE CASCADE,
        FOREIGN KEY(insight_id) REFERENCES audio_insights(id) ON DELETE SET NULL
      )
    ''');
    await _createAudioIntelligenceIndexes(db);
  }

  static Future<void> _createAudioIntelligenceJobsSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_intelligence_jobs (
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
      'CREATE INDEX IF NOT EXISTS audio_intelligence_jobs_recording_status '
      'ON audio_intelligence_jobs(recording_id, status, created_at_ms, id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS audio_intelligence_jobs_generation_status '
      'ON audio_intelligence_jobs(generation_id, status, id)',
    );
  }

  static Future<void> _createAudioIntelligenceIndexes(Database db) async {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS audio_notes_recording_order '
      'ON audio_notes(recording_id, created_at_ms DESC, id DESC)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS audio_insights_note_status '
      'ON audio_insights(note_id, status, kind, id)',
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
      'CREATE INDEX IF NOT EXISTS audio_note_revisions_note_order '
      'ON audio_note_revisions(note_id, created_at_ms DESC, id DESC)',
    );
  }

  static Future<void> _createSpeakerSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS audio_speakers (
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
          REFERENCES audio_speakers(id) ON DELETE SET NULL
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
        FOREIGN KEY(speaker_id) REFERENCES audio_speakers(id) ON DELETE CASCADE
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
        FOREIGN KEY(speaker_id) REFERENCES audio_speakers(id) ON DELETE SET NULL
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
      'CREATE INDEX IF NOT EXISTS audio_speakers_generation_order '
      'ON audio_speakers(generation_id, merged_into_speaker_id, id)',
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

  static Future<void> _createCompanionMediaTransferSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS companion_peers (
        device_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        identity_fingerprint TEXT NOT NULL,
        pending_pairing_id TEXT,
        trust_state TEXT NOT NULL
          CHECK (trust_state IN ('active', 'revoked', 'repair_required')),
        paired_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER,
        revoked_at_ms INTEGER
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS companion_transfers (
        transfer_id TEXT NOT NULL,
        whole_file_sha256 TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('send', 'receive')),
        peer_device_id TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 4096 AND 1048576),
        chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 65536),
        state TEXT NOT NULL
          CHECK (
            state IN (
              'pending',
              'transferring',
              'paused',
              'verifying',
              'committed',
              'failed',
              'canceled'
            )
          ),
        recording_id INTEGER,
        receipt_json TEXT,
        source_cleanup_state TEXT NOT NULL DEFAULT 'retained'
          CHECK (
            source_cleanup_state IN (
              'retained',
              'deferred',
              'deleted',
              'not_applicable'
            )
          ),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        PRIMARY KEY (transfer_id, whole_file_sha256),
        UNIQUE (transfer_id),
        FOREIGN KEY(peer_device_id) REFERENCES companion_peers(device_id),
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS companion_transfer_chunks (
        transfer_id TEXT NOT NULL,
        whole_file_sha256 TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 65535),
        chunk_sha256 TEXT NOT NULL,
        plaintext_bytes INTEGER NOT NULL
          CHECK (plaintext_bytes BETWEEN 1 AND 1048576),
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY (transfer_id, whole_file_sha256, chunk_index),
        FOREIGN KEY(transfer_id, whole_file_sha256)
          REFERENCES companion_transfers(transfer_id, whole_file_sha256)
          ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS companion_transfers_peer_history '
      'ON companion_transfers(peer_device_id, created_at_ms DESC)',
    );
  }

  static Future<void> _createDesktopCaptureSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_capture_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
          CHECK (
            state IN (
              'preparing', 'recording', 'paused', 'finalizing',
              'completed', 'recoverable', 'partial_capture', 'failed'
            )
          ),
        workspace_path TEXT NOT NULL,
        capture_timeline_ms INTEGER NOT NULL DEFAULT 0
          CHECK (capture_timeline_ms >= 0),
        partial_capture INTEGER NOT NULL DEFAULT 0
          CHECK (partial_capture IN (0, 1)),
        recording_id INTEGER,
        recording_sha256 TEXT
          CHECK (
            recording_sha256 IS NULL OR
            length(recording_sha256) = 64
          ),
        recovery_disposition TEXT
          CHECK (
            recovery_disposition IS NULL OR
            recovery_disposition IN (
              'completed_recovery', 'kept_partial', 'discarded'
            )
          ),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE SET NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_capture_tracks (
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('system_audio', 'microphone')),
        healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
        sample_rate REAL NOT NULL CHECK (sample_rate > 0),
        channels INTEGER NOT NULL CHECK (channels BETWEEN 1 AND 32),
        format TEXT NOT NULL,
        PRIMARY KEY(session_id, kind),
        FOREIGN KEY(session_id)
          REFERENCES desktop_capture_sessions(session_id)
          ON DELETE CASCADE
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_capture_chunks (
        session_id TEXT NOT NULL,
        track_kind TEXT NOT NULL
          CHECK (track_kind IN ('system_audio', 'microphone')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
        relative_path TEXT NOT NULL
          CHECK (
            relative_path NOT LIKE '/%' AND
            relative_path NOT LIKE '%..%'
          ),
        bytes INTEGER NOT NULL CHECK (bytes > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        finalized INTEGER NOT NULL DEFAULT 1 CHECK (finalized = 1),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, track_kind, sequence),
        UNIQUE(session_id, relative_path),
        FOREIGN KEY(session_id, track_kind)
          REFERENCES desktop_capture_tracks(session_id, kind)
          ON DELETE CASCADE
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_capture_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        monotonic_ms INTEGER NOT NULL CHECK (monotonic_ms >= 0),
        kind TEXT NOT NULL
          CHECK (
            kind IN (
              'device_changed', 'permission_revoked', 'gap_started',
              'gap_ended', 'format_changed', 'disk_low', 'encoder_failed'
            )
          ),
        track_kind TEXT NOT NULL
          CHECK (track_kind IN ('system_audio', 'microphone', 'all')),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence),
        FOREIGN KEY(session_id)
          REFERENCES desktop_capture_sessions(session_id)
          ON DELETE CASCADE
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_capture_command_receipts (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK (
            action IN ('start', 'pause', 'resume', 'stop', 'recover', 'discard')
          ),
        result_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, idempotency_key),
        FOREIGN KEY(session_id)
          REFERENCES desktop_capture_sessions(session_id)
          ON DELETE CASCADE
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS desktop_capture_sessions_recovery '
      'ON desktop_capture_sessions(state, updated_at_ms, session_id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS desktop_capture_chunks_timeline '
      'ON desktop_capture_chunks('
      'session_id, track_kind, start_ms, sequence'
      ')',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS desktop_capture_events_timeline '
      'ON desktop_capture_events(session_id, monotonic_ms, sequence)',
    );
  }

  static Future<void> _createDesktopLiveCaptionSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS desktop_live_caption_sessions (
        session_id TEXT PRIMARY KEY,
        generation_id INTEGER NOT NULL UNIQUE,
        recording_id INTEGER,
        state TEXT NOT NULL
          CHECK (
            state IN (
              'preparing', 'running', 'paused', 'flushing',
              'flushed', 'failed'
            )
          ),
        spool_relative_path TEXT NOT NULL
          CHECK (
            spool_relative_path NOT LIKE '/%' AND
            spool_relative_path NOT LIKE '%..%'
          ),
        worker_offset_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            worker_offset_bytes >= 0 AND
            worker_offset_bytes % 2 = 0
          ),
        last_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_sequence >= 0),
        model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),
        profile_id TEXT NOT NULL,
        error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(session_id)
          REFERENCES desktop_capture_sessions(session_id)
          ON DELETE CASCADE,
        FOREIGN KEY(generation_id)
          REFERENCES transcript_generations(id)
          ON DELETE CASCADE,
        FOREIGN KEY(recording_id)
          REFERENCES recordings(id)
          ON DELETE SET NULL
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS desktop_live_caption_recovery '
      'ON desktop_live_caption_sessions(state, updated_at_ms, session_id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_generations_authority '
      'ON transcript_generations('
      'recording_id, generation_kind, reconciliation_state, id'
      ')',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS transcript_segments_caption_order '
      'ON transcript_segments('
      'caption_session_id, generation_id, sequence_id, worker_offset_bytes'
      ')',
    );
  }
}
