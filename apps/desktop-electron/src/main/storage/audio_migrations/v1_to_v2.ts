import type { DatabaseSync } from "node:sqlite";

export const LEGACY_AI_PROFILE_ID = "legacy-default";

/**
 * Converts a validated Audio v1 schema while the caller owns one transaction.
 * The legacy provider ID remains the Keychain lookup reference; no secret is
 * read or copied through SQLite.
 */
export function migrateAudioSchemaV1ToV2(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE ai_provider_profiles (
      profile_id TEXT PRIMARY KEY CHECK (length(trim(profile_id)) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind = 'custom'),
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 128),
      normalized_display_name TEXT NOT NULL UNIQUE CHECK (
        length(trim(normalized_display_name)) BETWEEN 1 AND 128
      ),
      protocol TEXT NOT NULL CHECK (protocol IN ('deepseek', 'openai-compatible')),
      model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
      endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
      secret_ref TEXT NOT NULL UNIQUE CHECK (length(trim(secret_ref)) BETWEEN 1 AND 256),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    CREATE UNIQUE INDEX ai_provider_profiles_normalized_name
      ON ai_provider_profiles(normalized_display_name COLLATE NOCASE);

    CREATE TABLE ai_provider_selection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      selected_profile_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      FOREIGN KEY(selected_profile_id) REFERENCES ai_provider_profiles(profile_id) ON DELETE SET NULL
    );

    PRAGMA legacy_alter_table = ON;
    ALTER TABLE ai_consents RENAME TO ai_consents_v1;
    CREATE TABLE ai_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      endpoint_origin TEXT NOT NULL,
      endpoint_identity_sha256 TEXT NOT NULL CHECK (length(endpoint_identity_sha256) = 64),
      transcript_scope_sha256 TEXT NOT NULL CHECK (
        length(transcript_scope_sha256) = 64 AND transcript_scope_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      consent_version INTEGER NOT NULL CHECK (consent_version = 1),
      granted_at_ms INTEGER NOT NULL,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES audio_generations(id) ON DELETE CASCADE,
      UNIQUE(audio_id, generation_id, profile_id, provider_id, endpoint_identity_sha256, transcript_scope_sha256, consent_version)
    );
    INSERT INTO ai_consents (
      id, audio_id, generation_id, profile_id, provider_id, endpoint,
      endpoint_origin, endpoint_identity_sha256, transcript_scope_sha256,
      consent_version, granted_at_ms
    )
    SELECT id, audio_id, generation_id, '${LEGACY_AI_PROFILE_ID}', provider_id,
      endpoint, endpoint_origin, endpoint_identity_sha256,
      transcript_scope_sha256, consent_version, granted_at_ms
    FROM ai_consents_v1;
    DROP TABLE ai_consents_v1;
    PRAGMA legacy_alter_table = OFF;
    ALTER TABLE ai_jobs ADD COLUMN profile_id TEXT;
    ALTER TABLE ai_jobs ADD COLUMN secret_ref TEXT;
  `);

  database
    .prepare(
      `INSERT INTO ai_provider_profiles (
         profile_id, kind, display_name, normalized_display_name, protocol,
         model_id, endpoint, secret_ref, created_at_ms, updated_at_ms, revision
       )
       SELECT ?, 'custom',
              CASE provider_id
                WHEN 'deepseek' THEN 'DeepSeek'
                ELSE 'OpenAI Compatible'
              END,
              CASE provider_id
                WHEN 'deepseek' THEN 'deepseek'
                ELSE 'openai compatible'
              END,
              provider_id, model_id, endpoint, provider_id,
              updated_at_ms, updated_at_ms, 0
       FROM ai_provider_settings WHERE id = 1`,
    )
    .run(LEGACY_AI_PROFILE_ID);

  database
    .prepare(
      `INSERT INTO ai_provider_selection (id, selected_profile_id, revision)
       SELECT 1, ?, 0 WHERE EXISTS (
         SELECT 1 FROM ai_provider_profiles WHERE profile_id = ?
       )`,
    )
    .run(LEGACY_AI_PROFILE_ID, LEGACY_AI_PROFILE_ID);
  database.exec(`
    INSERT INTO ai_provider_selection (id, selected_profile_id, revision)
      VALUES (1, NULL, 0) ON CONFLICT(id) DO NOTHING;
    UPDATE ai_jobs
      SET profile_id = '${LEGACY_AI_PROFILE_ID}', secret_ref = provider_id;
    DROP TABLE ai_provider_settings;
  `);
}
