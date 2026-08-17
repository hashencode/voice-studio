import type { DatabaseSync } from "node:sqlite";

export const AUDIO_SCHEMA_VERSION = 1;
export const AUDIO_APPLICATION_ID = 0x56324155;

export const REQUIRED_AUDIO_SCHEMA_TABLES = [
  "audio_items",
  "audio_processing_jobs",
  "audio_transcript_segments",
] as const;

export function createAudioSchemaV1(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE audio_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_identity TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      media_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
    );

    CREATE TABLE audio_processing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL REFERENCES audio_items(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'canceled')),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      UNIQUE(audio_id, operation_id)
    );

    CREATE TABLE audio_transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL REFERENCES audio_items(id) ON DELETE CASCADE,
      sequence_id INTEGER NOT NULL CHECK (sequence_id >= 0),
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
      UNIQUE(audio_id, sequence_id)
    );

    CREATE INDEX audio_processing_jobs_state_order
      ON audio_processing_jobs(state, created_at_ms, id);
    CREATE INDEX audio_transcript_segments_audio_order
      ON audio_transcript_segments(audio_id, sequence_id);
  `);
}
