import type { DatabaseSync } from "node:sqlite";

export function addAudioAiSchemaV1(database: DatabaseSync): void {
  addAudioAiSchemaVersion(database, legacyProviderSettingsSchema, "", "");
}

export function addAudioAiSchema(database: DatabaseSync): void {
  addAudioAiSchemaVersion(
    database,
    providerProfilesSchemaV3,
    "profile_id TEXT NOT NULL,",
    `profile_id TEXT NOT NULL,
     secret_ref TEXT NOT NULL,
     provider_display_name TEXT NOT NULL CHECK (length(trim(provider_display_name)) BETWEEN 1 AND 128),`,
  );
}

export function addAudioAiSchemaV2(database: DatabaseSync): void {
  addAudioAiSchemaVersion(
    database,
    providerProfilesSchemaV2,
    "profile_id TEXT NOT NULL,",
    `profile_id TEXT NOT NULL,
     secret_ref TEXT NOT NULL,
     provider_display_name TEXT NOT NULL CHECK (length(trim(provider_display_name)) BETWEEN 1 AND 128),`,
  );
}

function addAudioAiSchemaVersion(
  database: DatabaseSync,
  providerSchema: string,
  consentProfileColumn: string,
  jobProfileColumns: string,
): void {
  database.exec(`
    ${providerSchema}

    CREATE TABLE ai_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      ${consentProfileColumn}
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
      UNIQUE(audio_id, generation_id, ${consentProfileColumn ? "profile_id," : ""} provider_id, endpoint_identity_sha256, transcript_scope_sha256, consent_version)
    );

    CREATE TABLE ai_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      consent_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      ${jobProfileColumns}
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      endpoint_origin TEXT NOT NULL,
      endpoint_identity_sha256 TEXT NOT NULL CHECK (length(endpoint_identity_sha256) = 64),
      transcript_scope_sha256 TEXT NOT NULL CHECK (length(transcript_scope_sha256) = 64),
      template_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES audio_generations(id) ON DELETE CASCADE,
      FOREIGN KEY(consent_id) REFERENCES ai_consents(id) ON DELETE RESTRICT
    );
    CREATE INDEX ai_jobs_audio_order ON ai_jobs(audio_id, updated_at_ms DESC, id DESC);
    CREATE INDEX ai_jobs_reconciliation ON ai_jobs(state, updated_at_ms, id);

    CREATE TABLE ai_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL UNIQUE,
      audio_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      output_schema_version TEXT NOT NULL CHECK (output_schema_version = 'audio_intelligence_output/v1'),
      suggested_title TEXT,
      audio_type TEXT,
      output_json TEXT NOT NULL CHECK (json_valid(output_json)),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY(audio_id) REFERENCES audio_items(id) ON DELETE CASCADE,
      FOREIGN KEY(generation_id) REFERENCES audio_generations(id) ON DELETE CASCADE
    );
    CREATE TABLE ai_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
      action_owner TEXT,
      action_due_at_ms INTEGER,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      FOREIGN KEY(note_id) REFERENCES ai_notes(id) ON DELETE CASCADE,
      UNIQUE(note_id, sort_order)
    );
    CREATE TABLE ai_evidence_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insight_id INTEGER NOT NULL,
      segment_id INTEGER NOT NULL,
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
      FOREIGN KEY(insight_id) REFERENCES ai_insights(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE RESTRICT,
      UNIQUE(insight_id, segment_id, start_ms, end_ms)
    );
    CREATE TABLE ai_command_receipts (
      idempotency_key TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('generate', 'retry')),
      expected_attempt INTEGER,
      result_attempt INTEGER NOT NULL CHECK (result_attempt >= 0),
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE
    );
  `);
}

const legacyProviderSettingsSchema = `
  CREATE TABLE ai_provider_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider_id TEXT NOT NULL CHECK (provider_id IN ('deepseek', 'openai-compatible')),
    model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
    endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
    updated_at_ms INTEGER NOT NULL
  );
  INSERT INTO ai_provider_settings VALUES
    (1, 'deepseek', 'deepseek-chat', 'https://api.deepseek.com', 0);
`;

const providerProfilesSchemaV2 = `
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
  INSERT INTO ai_provider_selection (id, selected_profile_id, revision)
    VALUES (1, NULL, 0);
`;

const providerProfilesSchemaV3 = `
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

  CREATE TABLE ai_provider_selection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    selected_profile_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    FOREIGN KEY(selected_profile_id) REFERENCES ai_provider_profiles(profile_id) ON DELETE SET NULL
  );
  INSERT INTO ai_provider_selection (id, selected_profile_id, revision)
    VALUES (1, NULL, 0);

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
`;
