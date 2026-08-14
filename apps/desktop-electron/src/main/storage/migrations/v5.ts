import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV4ToV5(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE meetings ADD COLUMN active_generation_id INTEGER;

    CREATE TABLE meeting_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      publication_id INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('formal', 'live-draft')),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      partial_success INTEGER NOT NULL DEFAULT 0 CHECK (partial_success IN (0, 1)),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(publication_id) REFERENCES result_publications(id) ON DELETE CASCADE
    );

    CREATE TABLE meeting_speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      stable_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('machine', 'manual')),
      merged_into_speaker_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES meeting_generations(id) ON DELETE CASCADE,
      FOREIGN KEY(merged_into_speaker_id) REFERENCES meeting_speakers(id) ON DELETE SET NULL,
      UNIQUE(generation_id, stable_key)
    );

    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      stable_key TEXT NOT NULL,
      sequence_id INTEGER NOT NULL CHECK (sequence_id >= 0),
      machine_text TEXT NOT NULL CHECK (length(trim(machine_text)) > 0),
      text TEXT NOT NULL CHECK (length(trim(text)) > 0),
      text_source TEXT NOT NULL CHECK (text_source IN ('machine', 'manual')),
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
      review_state TEXT NOT NULL CHECK (review_state IN ('unreviewed', 'needs-review', 'reviewed')),
      speaker_state TEXT NOT NULL CHECK (speaker_state IN ('assigned', 'overlap', 'unknown')),
      speaker_id INTEGER,
      speaker_source TEXT NOT NULL CHECK (speaker_source IN ('machine', 'manual')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES meeting_generations(id) ON DELETE CASCADE,
      FOREIGN KEY(speaker_id) REFERENCES meeting_speakers(id) ON DELETE SET NULL,
      UNIQUE(generation_id, stable_key)
    );

    CREATE TABLE workspace_heads (
      meeting_id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE transcript_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      segment_stable_key TEXT NOT NULL,
      previous_text TEXT NOT NULL,
      previous_text_source TEXT NOT NULL CHECK (previous_text_source IN ('machine', 'manual')),
      previous_review_state TEXT NOT NULL CHECK (previous_review_state IN ('unreviewed', 'needs-review', 'reviewed')),
      next_text TEXT NOT NULL,
      next_text_source TEXT NOT NULL CHECK (next_text_source IN ('machine', 'manual')),
      next_review_state TEXT NOT NULL CHECK (next_review_state IN ('unreviewed', 'needs-review', 'reviewed')),
      created_at_ms INTEGER NOT NULL,
      reverted_at_ms INTEGER,
      invalidated_at_ms INTEGER,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE INDEX meeting_generations_meeting_order
      ON meeting_generations(meeting_id, created_at_ms DESC, id DESC);
    CREATE INDEX meeting_speakers_generation_order
      ON meeting_speakers(generation_id, id);
    CREATE INDEX transcript_segments_generation_order
      ON transcript_segments(generation_id, sequence_id, start_ms, id);
    CREATE INDEX transcript_segments_meeting_time
      ON transcript_segments(meeting_id, start_ms, end_ms);
    CREATE INDEX transcript_revisions_history
      ON transcript_revisions(meeting_id, invalidated_at_ms, reverted_at_ms, id);
  `);
}
