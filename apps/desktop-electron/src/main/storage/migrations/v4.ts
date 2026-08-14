import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV3ToV4(database: DatabaseSync): void {
  database.exec(`
    PRAGMA defer_foreign_keys = ON;

    CREATE TEMP TABLE processing_jobs_active_publications_v4 AS
      SELECT id AS meeting_id, active_publication_id
      FROM meetings
      WHERE active_publication_id IS NOT NULL;

    CREATE TABLE processing_jobs_v4 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'interrupted', 'completed', 'failed', 'canceled')
      ),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      source_identity TEXT,
      deadline_at_ms INTEGER,
      error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      cancel_requested_at_ms INTEGER,
      phase TEXT NOT NULL DEFAULT 'asr' CHECK (phase IN ('asr', 'diarization')),
      protocol_identity TEXT NOT NULL DEFAULT 'legacy-unbound',
      source_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      model_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      runtime_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      progress_fraction REAL NOT NULL DEFAULT 0
        CHECK (progress_fraction >= 0 AND progress_fraction <= 1),
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    INSERT INTO processing_jobs_v4 (
      id, meeting_id, idempotency_key, operation_id, resource_identity, state,
      attempt, source_identity, deadline_at_ms, error_code, created_at_ms,
      updated_at_ms, cancel_requested_at_ms, phase, protocol_identity,
      source_sha256, model_sha256, runtime_sha256, progress_fraction
    )
    SELECT
      id, meeting_id, idempotency_key, operation_id, resource_identity, state,
      attempt, source_identity, deadline_at_ms, error_code, created_at_ms,
      updated_at_ms, cancel_requested_at_ms, phase, protocol_identity,
      source_sha256, model_sha256, runtime_sha256, progress_fraction
    FROM processing_jobs;

    CREATE TABLE result_publications_v4 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      source_identity TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at_ms INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'asr',
      protocol_identity TEXT NOT NULL DEFAULT 'legacy-unbound',
      source_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      model_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      runtime_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound',
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(job_id) REFERENCES processing_jobs_v4(id) ON DELETE CASCADE,
      UNIQUE(operation_id, attempt, source_identity)
    );

    INSERT INTO result_publications_v4 (
      id, meeting_id, job_id, operation_id, attempt, source_identity,
      payload_json, created_at_ms, phase, protocol_identity, source_sha256,
      model_sha256, runtime_sha256
    )
    SELECT
      id, meeting_id, job_id, operation_id, attempt, source_identity,
      payload_json, created_at_ms, phase, protocol_identity, source_sha256,
      model_sha256, runtime_sha256
    FROM result_publications;

    UPDATE meetings SET active_publication_id = NULL
      WHERE active_publication_id IS NOT NULL;
    DROP TABLE result_publications;
    DROP TABLE processing_jobs;
    ALTER TABLE processing_jobs_v4 RENAME TO processing_jobs;
    ALTER TABLE result_publications_v4 RENAME TO result_publications;

    CREATE INDEX processing_jobs_claim_order
      ON processing_jobs(state, created_at_ms, id);
    CREATE INDEX result_publications_meeting_order
      ON result_publications(meeting_id, created_at_ms, id);

    UPDATE meetings
    SET active_publication_id = (
      SELECT active_publication_id
      FROM processing_jobs_active_publications_v4
      WHERE meeting_id = meetings.id
    )
    WHERE id IN (SELECT meeting_id FROM processing_jobs_active_publications_v4);

    DROP TABLE processing_jobs_active_publications_v4;
  `);
}
