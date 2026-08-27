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
} from "../../src/main/storage/audio_schema";
import { AiJobRepository } from "../../src/main/storage/repositories/ai_job_repository";

describe("U10 AI storage authority", () => {
  let database: DatabaseSync | undefined;
  let temporaryRoot: string | undefined;
  afterEach(() => {
    database?.close();
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
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_provider_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "ai_provider_profiles" },
      { name: "ai_provider_selection" },
    ]);
    expect(
      database.prepare("SELECT * FROM ai_provider_selection").get(),
    ).toEqual({ id: 1, selected_profile_id: null, revision: 0 });
    expect(
      JSON.stringify(
        database
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
          .all(),
      ),
    ).not.toMatch(/api_key|secret_value|sk-do-not-persist/);
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
      legacy.close();

      database = openAudioDatabase(databasePath);

      expect(
        database.prepare("SELECT * FROM ai_provider_profiles").get(),
      ).toEqual({
        profile_id: "legacy-default",
        kind: "custom",
        display_name: displayName,
        normalized_display_name: displayName.toLocaleLowerCase("en-US"),
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
          `SELECT provider_id, model_id, endpoint, profile_id, secret_ref FROM ai_jobs WHERE id = ?`,
        )
        .get(job.id),
    ).toEqual({
      provider_id: "deepseek",
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
      displayName: "Second",
      protocol: "deepseek",
      modelId: "deepseek-chat",
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
          ...identity,
          modelId: "deepseek-chat",
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
