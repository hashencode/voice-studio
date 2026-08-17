import type { DatabaseSync } from "node:sqlite";

export function addAudioWorkspaceIntegritySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TRIGGER audio_generation_publication_owner_insert
    BEFORE INSERT ON audio_generations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM result_publications
        WHERE id = NEW.publication_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'audio generation publication owner mismatch') END;
      SELECT CASE WHEN NEW.supersedes_generation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.supersedes_generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'superseded generation owner mismatch') END;
    END;
    CREATE TRIGGER audio_generation_publication_owner_update
    BEFORE UPDATE OF audio_id, publication_id, supersedes_generation_id ON audio_generations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM result_publications
        WHERE id = NEW.publication_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'audio generation publication owner mismatch') END;
      SELECT CASE WHEN NEW.supersedes_generation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.supersedes_generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'superseded generation owner mismatch') END;
    END;

    CREATE TRIGGER audio_active_generation_owner_update
    BEFORE UPDATE OF active_generation_id ON audio_items
    WHEN NEW.active_generation_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.active_generation_id AND audio_id = NEW.id
      ) THEN RAISE(ABORT, 'active generation owner mismatch') END;
    END;

    CREATE TRIGGER audio_speaker_owner_insert
    BEFORE INSERT ON audio_speakers
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'speaker generation owner mismatch') END;
      SELECT CASE WHEN NEW.merged_into_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.merged_into_speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'merged speaker owner mismatch') END;
    END;
    CREATE TRIGGER audio_speaker_owner_update
    BEFORE UPDATE OF audio_id, generation_id, merged_into_speaker_id ON audio_speakers
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'speaker generation owner mismatch') END;
      SELECT CASE WHEN NEW.merged_into_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.merged_into_speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'merged speaker owner mismatch') END;
    END;

    CREATE TRIGGER transcript_segment_owner_insert
    BEFORE INSERT ON transcript_segments
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'segment generation owner mismatch') END;
      SELECT CASE WHEN NEW.speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'segment speaker owner mismatch') END;
      SELECT CASE WHEN NEW.machine_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.machine_speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'machine speaker owner mismatch') END;
    END;
    CREATE TRIGGER transcript_segment_owner_update
    BEFORE UPDATE OF audio_id, generation_id, speaker_id, machine_speaker_id ON transcript_segments
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'segment generation owner mismatch') END;
      SELECT CASE WHEN NEW.speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
      ) THEN RAISE(ABORT, 'segment speaker owner mismatch') END;
      SELECT CASE WHEN NEW.machine_speaker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM audio_speakers
        WHERE id = NEW.machine_speaker_id
          AND audio_id = NEW.audio_id AND generation_id = NEW.generation_id
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
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'revision generation owner mismatch') END;
    END;
    CREATE TRIGGER transcript_revision_owner_update
    BEFORE UPDATE OF audio_id, generation_id ON transcript_revisions
    BEGIN
      SELECT CASE WHEN NEW.generation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM audio_generations
        WHERE id = NEW.generation_id AND audio_id = NEW.audio_id
      ) THEN RAISE(ABORT, 'revision generation owner mismatch') END;
    END;

    CREATE INDEX transcript_revisions_generation_history
      ON transcript_revisions(audio_id, generation_id, invalidated_at_ms, reverted_at_ms, id);
    CREATE INDEX audio_generations_reconciliation
      ON audio_generations(audio_id, reconciliation_state, id);
  `);
}
