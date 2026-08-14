import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV5ToV6(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE meeting_generations ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'active'
      CHECK (reconciliation_state IN ('active', 'pending'));
    ALTER TABLE meeting_generations ADD COLUMN supersedes_generation_id INTEGER;
    ALTER TABLE transcript_segments ADD COLUMN machine_speaker_id INTEGER;
    ALTER TABLE transcript_revisions ADD COLUMN generation_id INTEGER;

    UPDATE transcript_segments
      SET machine_speaker_id = CASE WHEN speaker_source = 'machine' THEN speaker_id ELSE NULL END;
    UPDATE transcript_revisions
      SET generation_id = (
        SELECT active_generation_id FROM meetings
        WHERE meetings.id = transcript_revisions.meeting_id
      );

    CREATE TRIGGER meeting_generation_publication_owner_insert
    BEFORE INSERT ON meeting_generations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM result_publications
        WHERE id = NEW.publication_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'meeting generation publication owner mismatch') END;
      SELECT CASE WHEN NEW.supersedes_generation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.supersedes_generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'superseded generation owner mismatch') END;
    END;
    CREATE TRIGGER meeting_generation_publication_owner_update
    BEFORE UPDATE OF meeting_id, publication_id, supersedes_generation_id ON meeting_generations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM result_publications
        WHERE id = NEW.publication_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'meeting generation publication owner mismatch') END;
      SELECT CASE WHEN NEW.supersedes_generation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.supersedes_generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'superseded generation owner mismatch') END;
    END;

    CREATE TRIGGER meeting_active_generation_owner_update
    BEFORE UPDATE OF active_generation_id ON meetings
    WHEN NEW.active_generation_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.active_generation_id AND meeting_id = NEW.id
      ) THEN RAISE(ABORT, 'active generation owner mismatch') END;
    END;

    CREATE TRIGGER meeting_speaker_owner_insert
    BEFORE INSERT ON meeting_speakers
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'speaker generation owner mismatch') END;
      SELECT CASE WHEN NEW.merged_into_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.merged_into_speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'merged speaker owner mismatch') END;
    END;
    CREATE TRIGGER meeting_speaker_owner_update
    BEFORE UPDATE OF meeting_id, generation_id, merged_into_speaker_id ON meeting_speakers
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'speaker generation owner mismatch') END;
      SELECT CASE WHEN NEW.merged_into_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.merged_into_speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'merged speaker owner mismatch') END;
    END;

    CREATE TRIGGER transcript_segment_owner_insert
    BEFORE INSERT ON transcript_segments
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'segment generation owner mismatch') END;
      SELECT CASE WHEN NEW.speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'segment speaker owner mismatch') END;
      SELECT CASE WHEN NEW.machine_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.machine_speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'machine speaker owner mismatch') END;
    END;
    CREATE TRIGGER transcript_segment_owner_update
    BEFORE UPDATE OF meeting_id, generation_id, speaker_id, machine_speaker_id ON transcript_segments
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'segment generation owner mismatch') END;
      SELECT CASE WHEN NEW.speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'segment speaker owner mismatch') END;
      SELECT CASE WHEN NEW.machine_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM meeting_speakers
        WHERE id = NEW.machine_speaker_id
          AND meeting_id = NEW.meeting_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'machine speaker owner mismatch') END;
    END;

    CREATE TRIGGER transcript_machine_provenance_immutable
    BEFORE UPDATE OF machine_text, machine_speaker_id ON transcript_segments
    WHEN NEW.machine_text IS NOT OLD.machine_text
      OR NEW.machine_speaker_id IS NOT OLD.machine_speaker_id
    BEGIN
      SELECT RAISE(ABORT, 'machine transcript provenance is immutable');
    END;

    CREATE TRIGGER transcript_revision_owner_insert
    BEFORE INSERT ON transcript_revisions
    BEGIN
      SELECT CASE WHEN NEW.generation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'revision generation owner mismatch') END;
    END;
    CREATE TRIGGER transcript_revision_owner_update
    BEFORE UPDATE OF meeting_id, generation_id ON transcript_revisions
    BEGIN
      SELECT CASE WHEN NEW.generation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM meeting_generations
        WHERE id = NEW.generation_id AND meeting_id = NEW.meeting_id
      ) THEN RAISE(ABORT, 'revision generation owner mismatch') END;
    END;

    CREATE INDEX transcript_revisions_generation_history
      ON transcript_revisions(meeting_id, generation_id, invalidated_at_ms, reverted_at_ms, id);
    CREATE INDEX meeting_generations_reconciliation
      ON meeting_generations(meeting_id, reconciliation_state, id);
  `);
}
