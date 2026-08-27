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
  createAudioSchema,
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
      database
        .prepare("PRAGMA table_info(ai_provider_profiles)")
        .all()
        .map((column) => column.name),
    ).not.toContain("configuration_name");
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

  it("rejects a database falsely marked current with a malformed cleanup queue", () => {
    temporaryRoot = mkdtempSync(
      join(tmpdir(), "voice2text-ai-malformed-current-"),
    );
    const databasePath = join(temporaryRoot, "malformed-current.sqlite3");
    const malformed = new DatabaseSync(databasePath);
    createAudioSchema(malformed);
    malformed.exec(`
      DROP TABLE ai_secret_cleanup_queue;
      CREATE TABLE ai_secret_cleanup_queue (secret_ref TEXT PRIMARY KEY);
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = ${AUDIO_SCHEMA_VERSION};
    `);
    malformed.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(
      /secret cleanup schema does not match v4/,
    );
  });

  it("binds consent and exactly-one note to audio provider endpoint and scope", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const command = {
      audioId: 1,
      generationId: 1,
      profileId: "profile-deepseek",
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
      profileId: "profile-deepseek",
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
      profileId: "profile-deepseek",
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
