import type { DatabaseSync } from "node:sqlite";

export function createSchemaV1(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_identity TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      media_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      active_publication_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(active_publication_id) REFERENCES result_publications(id) ON DELETE SET NULL
    );

    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL UNIQUE,
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
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE INDEX processing_jobs_claim_order
      ON processing_jobs(state, created_at_ms, id);

    CREATE TABLE meeting_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE durable_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE result_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      source_identity TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE,
      UNIQUE(operation_id, attempt, source_identity)
    );

    CREATE INDEX result_publications_meeting_order
      ON result_publications(meeting_id, created_at_ms, id);
  `);
}
