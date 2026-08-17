import type { DatabaseSync } from "node:sqlite";

export function addCaptionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE caption_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (
        'preparing', 'running', 'paused', 'flushing', 'flushed', 'degraded'
      )),
      worker_attempt INTEGER NOT NULL DEFAULT 1 CHECK (worker_attempt > 0),
      model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),
      resource_identity TEXT NOT NULL CHECK (length(resource_identity) = 64),
      runtime_sha256 TEXT NOT NULL CHECK (length(runtime_sha256) = 64),
      protocol_identity TEXT NOT NULL,
      offset_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
        offset_bytes >= 0 AND offset_bytes % 3200 = 0
      ),
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      backlog_bytes INTEGER NOT NULL DEFAULT 0 CHECK (backlog_bytes >= 0),
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE caption_utterances (
      caption_session_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      worker_attempt INTEGER NOT NULL CHECK (worker_attempt > 0),
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
      text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 4000),
      language TEXT NOT NULL CHECK (length(trim(language)) BETWEEN 1 AND 32),
      worker_offset_bytes INTEGER NOT NULL CHECK (
        worker_offset_bytes >= 0 AND worker_offset_bytes % 3200 = 0
      ),
      model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(caption_session_id, sequence),
      FOREIGN KEY(caption_session_id) REFERENCES caption_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE caption_formal_handoffs (
      session_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
      normalized_path TEXT NOT NULL,
      normalized_sha256 TEXT NOT NULL CHECK (length(normalized_sha256) = 64),
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      normalized_size_bytes INTEGER NOT NULL CHECK (normalized_size_bytes > 44),
      duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(receipt_json) <= 4096),
      resource_identity TEXT NOT NULL CHECK (length(resource_identity) = 64),
      protocol_identity TEXT NOT NULL,
      model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),
      runtime_sha256 TEXT NOT NULL CHECK (length(runtime_sha256) = 64),
      current_attempt INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
      state TEXT NOT NULL DEFAULT 'not_queued' CHECK (state IN (
        'not_queued', 'queued', 'running', 'completed', 'failed', 'interrupted'
      )),
      audio_id INTEGER,
      processing_job_id INTEGER UNIQUE,
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE RESTRICT,
      FOREIGN KEY(processing_job_id) REFERENCES processing_jobs(id) ON DELETE SET NULL
    );

    CREATE TABLE caption_formal_preparations (
      session_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
      resource_identity TEXT NOT NULL CHECK (length(resource_identity) = 64),
      protocol_identity TEXT NOT NULL,
      model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),
      runtime_sha256 TEXT NOT NULL CHECK (length(runtime_sha256) = 64),
      current_attempt INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
      state TEXT NOT NULL DEFAULT 'not_queued' CHECK (state IN ('not_queued', 'failed')),
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE caption_formal_attempts (
      session_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      audio_id INTEGER,
      processing_job_id INTEGER UNIQUE,
      generation_id INTEGER,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'completed', 'failed', 'interrupted'
      )),
      error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, attempt),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE,
      FOREIGN KEY(processing_job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES audio_generations(id) ON DELETE SET NULL
    );

    CREATE TABLE caption_command_receipts (
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('retry-formal')),
      expected_attempt INTEGER NOT NULL CHECK (expected_attempt >= 0),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, idempotency_key),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX caption_sessions_state_updated
      ON caption_sessions(state, updated_at_ms, id);
    CREATE INDEX caption_utterances_recent
      ON caption_utterances(caption_session_id, sequence DESC);
    CREATE INDEX caption_formal_attempts_state
      ON caption_formal_attempts(state, updated_at_ms, session_id, attempt);
  `);
}
