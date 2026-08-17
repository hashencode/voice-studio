import type { DatabaseSync } from "node:sqlite";

export function createAudioCoreSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE media_authorities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_sha256 TEXT NOT NULL UNIQUE CHECK (length(content_sha256) = 64),
      normalized_path TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 44),
      duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(receipt_json) <= 4096),
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE audio_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_identity TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      media_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      media_authority_id INTEGER,
      active_publication_id INTEGER,
      active_generation_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(media_authority_id) REFERENCES media_authorities(id) ON DELETE RESTRICT,
      FOREIGN KEY(active_publication_id) REFERENCES result_publications(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX audios_media_authority_unique
      ON audio_items(media_authority_id) WHERE media_authority_id IS NOT NULL;

    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
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
      cancel_requested_at_ms INTEGER,
      phase TEXT NOT NULL DEFAULT 'asr' CHECK (phase IN ('asr', 'diarization')),
      protocol_identity TEXT NOT NULL DEFAULT 'unbound',
      source_sha256 TEXT NOT NULL DEFAULT 'unbound',
      model_sha256 TEXT NOT NULL DEFAULT 'unbound',
      runtime_sha256 TEXT NOT NULL DEFAULT 'unbound',
      progress_fraction REAL NOT NULL DEFAULT 0
        CHECK (progress_fraction >= 0 AND progress_fraction <= 1),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE
    );

    CREATE INDEX processing_jobs_claim_order
      ON processing_jobs(state, created_at_ms, id);

    CREATE TABLE audio_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE
    );

    CREATE TABLE durable_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE
    );

    CREATE TABLE result_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      source_identity TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      phase TEXT NOT NULL DEFAULT 'asr',
      protocol_identity TEXT NOT NULL DEFAULT 'unbound',
      source_sha256 TEXT NOT NULL DEFAULT 'unbound',
      model_sha256 TEXT NOT NULL DEFAULT 'unbound',
      runtime_sha256 TEXT NOT NULL DEFAULT 'unbound',
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE,
      FOREIGN KEY(job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE,
      UNIQUE(operation_id, attempt, source_identity)
    );

    CREATE INDEX result_publications_audio_order
      ON result_publications(audio_id, created_at_ms, id);
  `);
}
