import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIO_SCHEMA_VERSION,
  openAudioDatabase,
} from "../../src/main/storage/audio_database";
import {
  AUDIO_APPLICATION_ID,
  createAudioSchemaV1,
  createAudioSchemaV2,
  createAudioSchemaV3,
} from "../../src/main/storage/audio_schema";
import { AiJobRepository } from "../../src/main/storage/repositories/ai_job_repository";

describe("U10 AI storage authority", () => {
  let database: DatabaseSync | undefined;
  let temporaryRoot: string | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporaryRoot) rmSync(temporaryRoot, { force: true, recursive: true });
  });

  it("creates fresh Audio AI profile storage without persisting secret material", () => {
    database = openAudioDatabase(":memory:");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: AUDIO_SCHEMA_VERSION,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'ai_provider_%' OR name = 'ai_secret_cleanup_queue') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "ai_provider_profiles" },
      { name: "ai_provider_selection" },
      { name: "ai_secret_cleanup_queue" },
    ]);
    expect(
      database.prepare("SELECT * FROM ai_provider_selection").get(),
    ).toEqual({ id: 1, selected_profile_id: null, revision: 0 });
    expect(
      database
        .prepare("PRAGMA table_info(ai_jobs)")
        .all()
        .find((column) => column.name === "provider_display_name"),
    ).toEqual(expect.objectContaining({ notnull: 1 }));
    expect(
      JSON.stringify(
        database
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
          .all(),
      ),
    ).not.toMatch(/api_key|secret_value|sk-do-not-persist/);
    expect(
      database.prepare("PRAGMA table_info(ai_provider_profiles)").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "configuration_name", notnull: 0 }),
      ]),
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_provider_profiles' ORDER BY name",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: "ai_provider_profiles_model_id_unique" },
      ]),
    );
  });

  it("rejects a database falsely marked v3 with a malformed cleanup queue", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "voice2text-ai-malformed-v3-"));
    const databasePath = join(temporaryRoot, "malformed-v3.sqlite3");
    const malformed = new DatabaseSync(databasePath);
    createAudioSchemaV3(malformed);
    malformed.exec(`
      DROP TABLE ai_secret_cleanup_queue;
      CREATE TABLE ai_secret_cleanup_queue (secret_ref TEXT PRIMARY KEY);
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = ${AUDIO_SCHEMA_VERSION};
    `);
    malformed.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(
      /secret cleanup schema does not match v3/,
    );
  });

  it("migrates v2 profile names to optional notes and preserves selection revisions", () => {
    const databasePath = createV2Database();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO ai_provider_profiles (
        profile_id, kind, display_name, normalized_display_name, protocol,
        model_id, endpoint, secret_ref, created_at_ms, updated_at_ms, revision
      ) VALUES
        ('deepseek-profile', 'custom', '工作模型', '工作模型', 'deepseek',
         'deepseek-chat', 'https://api.deepseek.com', 'secret-deepseek', 10, 20, 4),
        ('compatible-profile', 'custom', '备用模型', '备用模型', 'openai-compatible',
         'vendor-chat', 'https://ai.example.com/v1', 'secret-compatible', 11, 21, 5);
      UPDATE ai_provider_selection
        SET selected_profile_id = 'compatible-profile', revision = 7
        WHERE id = 1;
    `);
    legacy.close();

    database = openAudioDatabase(databasePath);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: AUDIO_SCHEMA_VERSION,
    });
    expect(
      database
        .prepare(
          `SELECT profile_id, configuration_name, protocol, model_id, endpoint,
                  secret_ref, created_at_ms, updated_at_ms, revision
             FROM ai_provider_profiles ORDER BY profile_id`,
        )
        .all(),
    ).toEqual([
      {
        profile_id: "compatible-profile",
        configuration_name: "备用模型",
        protocol: "openai-compatible",
        model_id: "vendor-chat",
        endpoint: "https://ai.example.com/v1",
        secret_ref: "secret-compatible",
        created_at_ms: 11,
        updated_at_ms: 21,
        revision: 5,
      },
      {
        profile_id: "deepseek-profile",
        configuration_name: "工作模型",
        protocol: "deepseek",
        model_id: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        secret_ref: "secret-deepseek",
        created_at_ms: 10,
        updated_at_ms: 20,
        revision: 4,
      },
    ]);
    expect(
      database.prepare("SELECT * FROM ai_provider_selection").get(),
    ).toEqual({
      id: 1,
      selected_profile_id: "compatible-profile",
      revision: 7,
    });
  });

  it("rejects a v2 duplicate-model collision without mutating the legacy store", () => {
    const databasePath = createV2Database();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO ai_provider_profiles (
        profile_id, kind, display_name, normalized_display_name, protocol,
        model_id, endpoint, secret_ref, created_at_ms, updated_at_ms, revision
      ) VALUES
        ('first', 'custom', 'First', 'first', 'openai-compatible',
         'shared-model', 'https://one.example.com/v1', 'secret-one', 1, 1, 0),
        ('second', 'custom', 'Second', 'second', 'openai-compatible',
         'shared-model', 'https://two.example.com/v1', 'secret-two', 2, 2, 0);
    `);
    legacy.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(/shared-model/);

    const preserved = new DatabaseSync(databasePath);
    expect(preserved.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    expect(
      preserved
        .prepare(
          "SELECT profile_id, display_name, model_id FROM ai_provider_profiles ORDER BY profile_id",
        )
        .all(),
    ).toEqual([
      { profile_id: "first", display_name: "First", model_id: "shared-model" },
      {
        profile_id: "second",
        display_name: "Second",
        model_id: "shared-model",
      },
    ]);
    preserved.close();
  });

  it.each([
    {
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      endpoint: "https://api.deepseek.com",
      displayName: "DeepSeek",
    },
    {
      providerId: "openai-compatible",
      modelId: "audio-model",
      endpoint: "https://ai.example.com/v1",
      displayName: "OpenAI Compatible",
    },
  ] as const)(
    "migrates a legacy $providerId setting into the selected custom profile",
    ({ providerId, modelId, endpoint, displayName }) => {
      const databasePath = createLegacyDatabase();
      const legacy = new DatabaseSync(databasePath);
      legacy
        .prepare(
          "UPDATE ai_provider_settings SET provider_id = ?, model_id = ?, endpoint = ?, updated_at_ms = ? WHERE id = 1",
        )
        .run(providerId, modelId, endpoint, 1234);
      seedAudio(legacy);
      const identity = {
        profileId: "legacy-default",
        providerId,
        endpointOrigin: new URL(endpoint).origin,
        endpointIdentitySha256: "c".repeat(64),
        transcriptScopeSha256: "d".repeat(64),
      };
      new AiJobRepository(legacy).enqueue(
        {
          audioId: 1,
          generationId: 1,
          ...identity,
          secretRef: providerId,
          providerDisplayName: displayName,
          modelId,
          endpoint,
          templateId: "default",
          idempotencyKey: `migrate-${providerId}-job`,
          nowMs: 1235,
        },
        { version: 1, ...identity },
      );
      legacy.close();

      database = openAudioDatabase(databasePath);

      expect(
        database.prepare("SELECT * FROM ai_provider_profiles").get(),
      ).toEqual({
        profile_id: "legacy-default",
        kind: "custom",
        configuration_name: displayName,
        protocol: providerId,
        model_id: modelId,
        endpoint,
        secret_ref: providerId,
        created_at_ms: 1234,
        updated_at_ms: 1234,
        revision: 0,
      });
      expect(
        database.prepare("SELECT * FROM ai_provider_selection").get(),
      ).toEqual({
        id: 1,
        selected_profile_id: "legacy-default",
        revision: 0,
      });
      expect(
        database.prepare("SELECT provider_display_name FROM ai_jobs").get(),
      ).toEqual({ provider_display_name: displayName });
      expect(
        database
          .prepare("PRAGMA table_info(ai_jobs)")
          .all()
          .filter((column) =>
            ["profile_id", "secret_ref", "provider_display_name"].includes(
              String(column.name),
            ),
          )
          .map((column) => ({
            name: column.name,
            notnull: column.notnull,
            defaultValue: column.dflt_value,
          })),
      ).toEqual([
        { name: "profile_id", notnull: 1, defaultValue: null },
        { name: "secret_ref", notnull: 1, defaultValue: null },
        { name: "provider_display_name", notnull: 1, defaultValue: null },
      ]);
    },
  );

  it("preserves immutable AI job, consent, note, and evidence history during migration", () => {
    const databasePath = createLegacyDatabase();
    const legacy = new DatabaseSync(databasePath);
    seedAudio(legacy);
    const repository = new AiJobRepository(legacy);
    const identity = {
      profileId: "legacy-default",
      providerId: "deepseek",
      endpointOrigin: "https://api.deepseek.com",
      endpointIdentitySha256: "f".repeat(64),
      transcriptScopeSha256: "e".repeat(64),
    } as const;
    const job = repository.enqueue(
      {
        audioId: 1,
        generationId: 1,
        ...identity,
        secretRef: "deepseek",
        providerDisplayName: "DeepSeek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        templateId: "default",
        idempotencyKey: "legacy-history-job",
        nowMs: 100,
      },
      { version: 1, ...identity },
    );
    repository.claim(job.id, 200);
    repository.publish(
      job.id,
      1,
      {
        schemaVersion: "audio_intelligence_output/v1",
        suggestedTitle: "Legacy note",
        audioType: null,
        items: [
          {
            kind: "decision",
            body: "preserve history",
            evidence: [{ segmentId: 7, startMs: 0, endMs: 1000 }],
            actionOwner: null,
            actionDueAtMs: null,
          },
        ],
      },
      300,
    );
    legacy.close();

    database = openAudioDatabase(databasePath);

    expect(
      database
        .prepare(
          `SELECT provider_id, provider_display_name, model_id, endpoint, profile_id, secret_ref FROM ai_jobs WHERE id = ?`,
        )
        .get(job.id),
    ).toEqual({
      provider_id: "deepseek",
      provider_display_name: "DeepSeek",
      model_id: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      profile_id: "legacy-default",
      secret_ref: "deepseek",
    });
    expect(
      database
        .prepare(
          "SELECT provider_id, endpoint, profile_id FROM ai_consents WHERE id = 1",
        )
        .get(),
    ).toEqual({
      provider_id: "deepseek",
      endpoint: "https://api.deepseek.com",
      profile_id: "legacy-default",
    });
    for (const table of [
      "ai_jobs",
      "ai_consents",
      "ai_notes",
      "ai_insights",
      "ai_evidence_links",
    ]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 1 });
    }
  });

  it("allows migrated stores to bind identical endpoint consent to distinct profiles", () => {
    const databasePath = createLegacyDatabase();
    database = openAudioDatabase(databasePath);
    seedAudio(database);
    const repository = new AiJobRepository(database);
    repository.createProfile({
      profileId: "second-profile",
      secretRef: "second-secret",
      configurationName: "Second",
      protocol: "deepseek",
      modelId: "deepseek-reasoner",
      endpoint: "https://api.deepseek.com",
      expectedRevision: 0,
      nowMs: 2,
    });
    const identity = {
      providerId: "deepseek" as const,
      endpointOrigin: "https://api.deepseek.com",
      endpointIdentitySha256: "c".repeat(64),
      transcriptScopeSha256: "a".repeat(64),
    };
    for (const [profileId, secretRef, idempotencyKey] of [
      ["legacy-default", "deepseek", "migrated-consent-first"],
      ["second-profile", "second-secret", "migrated-consent-second"],
    ] as const) {
      repository.enqueue(
        {
          audioId: 1,
          generationId: 1,
          profileId,
          secretRef,
          providerDisplayName:
            identity.providerId === "deepseek"
              ? "DeepSeek"
              : "OpenAI Compatible",
          ...identity,
          modelId:
            profileId === "legacy-default"
              ? "deepseek-chat"
              : "deepseek-reasoner",
          endpoint: "https://api.deepseek.com",
          templateId: "default",
          idempotencyKey,
          nowMs: 3,
        },
        { version: 1, profileId, ...identity },
      );
    }
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_consents").get(),
    ).toEqual({ count: 2 });
  });

  it("binds consent and exactly-one note to audio provider endpoint and scope", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const command = {
      audioId: 1,
      generationId: 1,
      profileId: "legacy-default",
      secretRef: "deepseek",
      providerDisplayName: "DeepSeek",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      endpointOrigin: "https://api.deepseek.com",
      endpointIdentitySha256: "c".repeat(64),
      transcriptScopeSha256: "a".repeat(64),
      templateId: "default",
      idempotencyKey: "ai-generate-00000001",
      nowMs: 1_000,
    } as const;
    expect(() => repository.enqueue(command, null)).toThrowError(
      expect.objectContaining({ code: "AI_CONSENT_REQUIRED" }),
    );
    const consent = {
      version: 1 as const,
      profileId: "legacy-default",
      providerId: command.providerId,
      endpointOrigin: command.endpointOrigin,
      endpointIdentitySha256: command.endpointIdentitySha256,
      transcriptScopeSha256: command.transcriptScopeSha256,
    };
    const job = repository.enqueue(command, consent);
    expect(repository.enqueue(command, consent).id).toBe(job.id);
    repository.claim(job.id, 2_000);
    const note = repository.publish(
      job.id,
      job.attempt + 1,
      {
        schemaVersion: "audio_intelligence_output/v1",
        suggestedTitle: null,
        audioType: null,
        items: [
          {
            kind: "decision",
            body: "ship",
            evidence: [{ segmentId: 7, startMs: 0, endMs: 1_000 }],
            actionOwner: null,
            actionDueAtMs: null,
          },
        ],
      },
      3_000,
    );
    expect(
      repository.publish(job.id, job.attempt + 1, note.output, 4_000).id,
    ).toBe(note.id);
    expect(() =>
      repository.publish(
        job.id,
        job.attempt + 1,
        {
          ...note.output,
          items: [{ ...note.output.items[0]!, body: "different" }],
        },
        5_000,
      ),
    ).toThrowError(expect.objectContaining({ code: "AI_ATTEMPT_CONFLICT" }));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({
      count: 1,
    });
  });

  it("reconciles queued and running work and retry cannot duplicate a note", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const consent = {
      version: 1 as const,
      profileId: "legacy-default",
      providerId: "deepseek",
      endpointOrigin: "https://api.deepseek.com",
      endpointIdentitySha256: "d".repeat(64),
      transcriptScopeSha256: "b".repeat(64),
    };
    const job = repository.enqueue(
      {
        audioId: 1,
        generationId: 1,
        profileId: consent.profileId,
        secretRef: "deepseek",
        providerDisplayName: "DeepSeek",
        providerId: consent.providerId,
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        endpointOrigin: consent.endpointOrigin,
        endpointIdentitySha256: consent.endpointIdentitySha256,
        transcriptScopeSha256: consent.transcriptScopeSha256,
        templateId: "default",
        idempotencyKey: "ai-generate-00000002",
        nowMs: 1_000,
      },
      consent,
    );
    const running = repository.claim(job.id, 2_000);
    const queued = repository.enqueue(
      {
        audioId: 1,
        generationId: 1,
        profileId: consent.profileId,
        secretRef: "deepseek",
        providerDisplayName: "DeepSeek",
        providerId: consent.providerId,
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        endpointOrigin: consent.endpointOrigin,
        endpointIdentitySha256: consent.endpointIdentitySha256,
        transcriptScopeSha256: consent.transcriptScopeSha256,
        templateId: "default",
        idempotencyKey: "ai-generate-00000003",
        nowMs: 2_500,
      },
      consent,
    );
    expect(queued.state).toBe("queued");
    expect(repository.reconcileInterrupted(3_000)).toBe(2);
    expect(repository.getJob(queued.id)?.state).toBe("interrupted");
    const retried = repository.retry({
      jobId: job.id,
      expectedAttempt: running.attempt,
      idempotencyKey: "ai-retry-0000000001",
      nowMs: 4_000,
    });
    expect(retried.attempt).toBe(running.attempt + 1);
    expect(
      repository.retry({
        jobId: job.id,
        expectedAttempt: running.attempt,
        idempotencyKey: "ai-retry-0000000001",
        nowMs: 5_000,
      }).attempt,
    ).toBe(retried.attempt);
    expect(() =>
      repository.retry({
        jobId: job.id,
        expectedAttempt: running.attempt + 1,
        idempotencyKey: "ai-retry-0000000001",
        nowMs: 5_500,
      }),
    ).toThrowError(expect.objectContaining({ code: "AI_ATTEMPT_CONFLICT" }));
    expect(() =>
      repository.retry({
        jobId: job.id,
        expectedAttempt: running.attempt,
        idempotencyKey: "ai-generate-00000002",
        nowMs: 5_600,
      }),
    ).toThrowError(expect.objectContaining({ code: "AI_ATTEMPT_CONFLICT" }));
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({ count: 0 });
  });

  function createLegacyDatabase(): string {
    temporaryRoot = mkdtempSync(join(tmpdir(), "voice2text-ai-migration-"));
    const databasePath = join(temporaryRoot, "audio.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON");
    createAudioSchemaV1(legacy);
    legacy.exec(`PRAGMA application_id = ${AUDIO_APPLICATION_ID}`);
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();
    return databasePath;
  }

  function createV2Database(): string {
    temporaryRoot = mkdtempSync(join(tmpdir(), "voice2text-ai-v2-migration-"));
    const databasePath = join(temporaryRoot, "audio.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON");
    createAudioSchemaV2(legacy);
    legacy.exec(`PRAGMA application_id = ${AUDIO_APPLICATION_ID}`);
    legacy.exec("PRAGMA user_version = 2");
    legacy.close();
    return databasePath;
  }
});

function seedAudio(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO audio_items (
      id, idempotency_key, source_identity, display_name, media_path,
      duration_ms, created_at_ms, updated_at_ms
    ) VALUES (1, 'audio-1', 'source-1', 'Audio', '/private/tmp/media.wav', 1000, 1, 1);
    INSERT INTO processing_jobs (
      id, audio_id, idempotency_key, operation_id, resource_identity,
      state, attempt, created_at_ms, updated_at_ms
    ) VALUES (1, 1, 'processing-1', 'asr', 'resource-1', 'completed', 1, 1, 1);
    INSERT INTO result_publications (
      id, audio_id, job_id, operation_id, attempt, source_identity,
      payload_json, created_at_ms
    ) VALUES (1, 1, 1, 'diarization', 1, 'source-1', '{}', 1);
    INSERT INTO audio_generations (
      id, audio_id, publication_id, kind, attempt, partial_success, created_at_ms
    ) VALUES (1, 1, 1, 'formal', 1, 0, 1);
    UPDATE audio_items SET active_generation_id = 1 WHERE id = 1;
    INSERT INTO transcript_segments (
      id, audio_id, generation_id, stable_key, sequence_id, machine_text, text,
      text_source, start_ms, end_ms, review_state, speaker_state, speaker_source,
      created_at_ms, updated_at_ms
    ) VALUES (7, 1, 1, 'segment-7', 0, 'ship', 'ship', 'machine', 0, 1000,
      'reviewed', 'unknown', 'machine', 1, 1);
  `);
}
