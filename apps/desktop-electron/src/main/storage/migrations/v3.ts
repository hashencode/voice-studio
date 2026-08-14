import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV2ToV3(database: DatabaseSync): void {
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

    ALTER TABLE meetings ADD COLUMN media_authority_id INTEGER
      REFERENCES media_authorities(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX meetings_media_authority_unique
      ON meetings(media_authority_id) WHERE media_authority_id IS NOT NULL;

    ALTER TABLE processing_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'asr'
      CHECK (phase IN ('asr', 'diarization'));
    ALTER TABLE processing_jobs ADD COLUMN protocol_identity TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE processing_jobs ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE processing_jobs ADD COLUMN model_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE processing_jobs ADD COLUMN runtime_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE processing_jobs ADD COLUMN progress_fraction REAL NOT NULL DEFAULT 0
      CHECK (progress_fraction >= 0 AND progress_fraction <= 1);

    ALTER TABLE result_publications ADD COLUMN phase TEXT NOT NULL DEFAULT 'asr';
    ALTER TABLE result_publications ADD COLUMN protocol_identity TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE result_publications ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE result_publications ADD COLUMN model_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
    ALTER TABLE result_publications ADD COLUMN runtime_sha256 TEXT NOT NULL DEFAULT 'legacy-unbound';
  `);
}
