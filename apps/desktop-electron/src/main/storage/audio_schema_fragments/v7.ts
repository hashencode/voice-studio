import type { DatabaseSync } from "node:sqlite";

export function addCaptureSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE capture_sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      workspace_path TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (
        'preparing', 'recording', 'paused', 'finalizing', 'completed',
        'recoverable', 'partial_capture', 'failed'
      )),
      capture_mode TEXT NOT NULL CHECK (capture_mode IN ('dual_track', 'microphone_only', 'system_audio_only')),
      capture_timeline_ms INTEGER NOT NULL DEFAULT 0 CHECK (capture_timeline_ms >= 0),
      system_audio_healthy INTEGER NOT NULL DEFAULT 0 CHECK (system_audio_healthy IN (0, 1)),
      microphone_healthy INTEGER NOT NULL DEFAULT 0 CHECK (microphone_healthy IN (0, 1)),
      partial_capture INTEGER NOT NULL DEFAULT 0 CHECK (partial_capture IN (0, 1)),
      finalized_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (finalized_chunk_count BETWEEN 0 AND 100000),
      event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 100000),
      gap_count INTEGER NOT NULL DEFAULT 0 CHECK (gap_count BETWEEN 0 AND 100000),
      interruption_reason TEXT,
      recording_sha256 TEXT,
      journal_sha256 TEXT,
      recovery_disposition TEXT CHECK (recovery_disposition IN ('kept', 'discarded')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE capture_command_receipts (
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN (
        'start', 'pause', 'resume', 'stop', 'recover', 'keep', 'discard',
        'system-sleep', 'system-wake'
      )),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(session_id, idempotency_key),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE capture_tracks (
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('system_audio', 'microphone')),
      healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
      sample_rate REAL NOT NULL CHECK (sample_rate > 0),
      channels INTEGER NOT NULL CHECK (channels BETWEEN 1 AND 32),
      format TEXT NOT NULL,
      PRIMARY KEY(session_id, kind),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE capture_chunks (
      session_id TEXT NOT NULL,
      track_kind TEXT NOT NULL CHECK (track_kind IN ('system_audio', 'microphone')),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
      relative_path TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes > 0),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      PRIMARY KEY(session_id, track_kind, sequence),
      UNIQUE(session_id, relative_path),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE capture_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      monotonic_ms INTEGER NOT NULL CHECK (monotonic_ms >= 0),
      kind TEXT NOT NULL,
      track_kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(session_id, sequence),
      FOREIGN KEY(session_id) REFERENCES capture_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX capture_sessions_recovery
      ON capture_sessions(state, recovery_disposition, updated_at_ms);
  `);
}
