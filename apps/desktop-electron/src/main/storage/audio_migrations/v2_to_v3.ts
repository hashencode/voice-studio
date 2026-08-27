import type { DatabaseSync } from "node:sqlite";

export class AudioSchemaMigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioSchemaMigrationConflictError";
  }
}

/** Converts a validated Audio v2 schema while the caller owns one transaction. */
export function migrateAudioSchemaV2ToV3(database: DatabaseSync): void {
  const collisions = database
    .prepare(
      `SELECT trim(model_id) AS model_id
         FROM ai_provider_profiles
        GROUP BY trim(model_id)
       HAVING COUNT(*) > 1
        ORDER BY trim(model_id)`,
    )
    .all()
    .map((row) => String(row.model_id));
  if (collisions.length > 0) {
    throw new AudioSchemaMigrationConflictError(
      `Duplicate cloud model IDs must be resolved before migration: ${collisions.map((modelId) => JSON.stringify(modelId)).join(", ")}`,
    );
  }

  database.exec(`
    ALTER TABLE ai_provider_selection RENAME TO ai_provider_selection_v2;
    ALTER TABLE ai_provider_profiles RENAME TO ai_provider_profiles_v2;

    CREATE TABLE ai_provider_profiles (
      profile_id TEXT PRIMARY KEY CHECK (length(trim(profile_id)) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind = 'custom'),
      configuration_name TEXT CHECK (
        configuration_name IS NULL OR
        (configuration_name = trim(configuration_name) AND length(configuration_name) BETWEEN 1 AND 128)
      ),
      protocol TEXT NOT NULL CHECK (protocol IN ('deepseek', 'openai-compatible')),
      model_id TEXT NOT NULL CHECK (
        model_id = trim(model_id) AND length(model_id) BETWEEN 1 AND 256
      ),
      endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
      secret_ref TEXT NOT NULL UNIQUE CHECK (length(trim(secret_ref)) BETWEEN 1 AND 256),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    CREATE UNIQUE INDEX ai_provider_profiles_model_id_unique
      ON ai_provider_profiles(model_id);

    INSERT INTO ai_provider_profiles (
      profile_id, kind, configuration_name, protocol, model_id, endpoint,
      secret_ref, created_at_ms, updated_at_ms, revision
    )
    SELECT profile_id, kind, trim(display_name), protocol, trim(model_id), endpoint,
           secret_ref, created_at_ms, updated_at_ms, revision
      FROM ai_provider_profiles_v2;

    CREATE TABLE ai_provider_selection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      selected_profile_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      FOREIGN KEY(selected_profile_id) REFERENCES ai_provider_profiles(profile_id) ON DELETE SET NULL
    );
    INSERT INTO ai_provider_selection (id, selected_profile_id, revision)
      SELECT id, selected_profile_id, revision FROM ai_provider_selection_v2;

    DROP TABLE ai_provider_profiles_v2;
    DROP TABLE ai_provider_selection_v2;

    CREATE TABLE ai_secret_cleanup_queue (
      secret_ref TEXT PRIMARY KEY CHECK (length(trim(secret_ref)) BETWEEN 1 AND 256),
      operation TEXT NOT NULL CHECK (operation IN ('delete-keychain-item')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'failed')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      error_code TEXT CHECK (
        error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 64
      )
    );
  `);
}
