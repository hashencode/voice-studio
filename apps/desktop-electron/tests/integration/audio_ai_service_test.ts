import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioAiService } from "../../src/main/domain/audio-intelligence/audio_ai_service";
import { AiProviderFailure } from "../../src/main/domain/audio-intelligence/provider_security";
import type { DesktopSecretStorePort } from "../../src/main/features/secrets/secret_store_port";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { AiJobRepository } from "../../src/main/storage/repositories/ai_job_repository";

describe("U10 audio AI vertical slice", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  it("prepares settings and consent scope without secret access or network", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    const generate = vi.fn();
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      () => 10,
    );

    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });

    expect(preview).toMatchObject({
      providerId: "deepseek",
      endpointOrigin: "https://api.deepseek.com",
      audioTitle: "Audio",
      segmentCount: 1,
      requiresConsent: true,
    });
    expect(preview.endpointIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.transcriptScopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.read).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_consents").get(),
    ).toEqual({ count: 0 });
  });

  it("requires exact fresh consent then publishes one durable note", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    const generate = vi.fn(async () => output());
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const request = {
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-service-0001",
      consent: consent(preview),
    };

    await expect(
      service.generate({
        ...request,
        consent: { ...request.consent, transcriptScopeSha256: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "AI_CONSENT_REQUIRED" });
    expect(generate).not.toHaveBeenCalled();

    const completed = await service.generate(request);
    new AiJobRepository(database).saveSettings(
      {
        providerId: "openai-compatible",
        modelId: "another-model",
        endpoint: "https://ai.example.com",
      },
      9_999,
    );
    const replay = await service.generate(request);
    expect(completed.state).toBe("completed");
    expect(completed.note?.items[0]?.body).toBe("ship");
    expect(replay.jobId).toBe(completed.jobId);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({ count: 1 });
  });

  it("invalidates consent when the exact provider audio title changes", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    const generate = vi.fn(async () => output());
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const previous = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    database
      .prepare("UPDATE audio_items SET display_name = ? WHERE id = 1")
      .run("Renamed audio");
    const renamed = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });

    expect(renamed.transcriptScopeSha256).not.toBe(
      previous.transcriptScopeSha256,
    );
    await expect(
      service.generate({
        audioId: 1,
        generationId: 1,
        templateId: "default",
        idempotencyKey: "ai-generate-title-change-0001",
        consent: consent(previous),
      }),
    ).rejects.toMatchObject({ code: "AI_CONSENT_REQUIRED" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("records provider failure with no fallback and retry stays exactly once", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const secrets = secretStore();
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new AiProviderFailure("AI_SERVICE_UNAVAILABLE", "down"),
      )
      .mockResolvedValueOnce(output());
    const service = new AudioAiService(
      repository,
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const failed = await service.generate({
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-service-0002",
      consent: consent(preview),
    });
    expect(failed).toMatchObject({
      state: "failed",
      errorCode: "AI_SERVICE_UNAVAILABLE",
    });
    const completed = await service.retry({
      jobId: failed.jobId,
      expectedAttempt: failed.attempt,
      idempotencyKey: "ai-retry-service-000001",
      consent: consent(preview),
    });
    database
      .prepare("UPDATE audio_items SET display_name = ? WHERE id = 1")
      .run("Renamed after completed retry");
    const replay = await service.retry({
      jobId: failed.jobId,
      expectedAttempt: failed.attempt,
      idempotencyKey: "ai-retry-service-000001",
      consent: consent(preview),
    });
    expect(completed.state).toBe("completed");
    expect(replay.jobId).toBe(completed.jobId);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({ count: 1 });
  });

  it("allows at most one active provider request across jobs", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const generate = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await firstPending;
      active -= 1;
      return output();
    });
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const first = service.generate({
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-concurrent-0001",
      consent: consent(preview),
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const rejected = await service.generate({
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-concurrent-0002",
      consent: consent(preview),
    });
    releaseFirst();
    const completed = await first;

    expect(rejected).toMatchObject({
      state: "failed",
      errorCode: "AI_SERVICE_UNAVAILABLE",
    });
    expect(completed.state).toBe("completed");
    expect(maximumActive).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent exact generate replays into one provider call and note", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(async () => {
      await pending;
      return output();
    });
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const request = {
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-concurrent-replay-0001",
      consent: consent(preview),
    };

    const replays = Promise.all([
      service.generate(request),
      service.generate(request),
    ]);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    release();
    const snapshots = await replays;

    expect(new Set(snapshots.map((snapshot) => snapshot.jobId)).size).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_jobs").get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({ count: 1 });
  });

  it("coalesces concurrent exact retry replays into one provider call and note", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const secrets = secretStore();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new AiProviderFailure("AI_SERVICE_UNAVAILABLE", "down"),
      )
      .mockImplementationOnce(async () => {
        await pending;
        return output();
      });
    const service = new AudioAiService(
      new AiJobRepository(database),
      secrets.port,
      () => ({ id: "deepseek", generate }),
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const failed = await service.generate({
      audioId: 1,
      generationId: 1,
      templateId: "default",
      idempotencyKey: "ai-generate-before-retry-replay-0001",
      consent: consent(preview),
    });
    const request = {
      jobId: failed.jobId,
      expectedAttempt: failed.attempt,
      idempotencyKey: "ai-retry-concurrent-replay-0001",
      consent: consent(preview),
    };

    const replays = Promise.all([
      service.retry(request),
      service.retry(request),
    ]);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    release();
    const snapshots = await replays;

    expect(new Set(snapshots.map((snapshot) => snapshot.jobId)).size).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM ai_notes").get(),
    ).toEqual({ count: 1 });
  });
});

function consent(preview: ReturnType<AudioAiService["prepare"]>) {
  return {
    version: 1 as const,
    providerId: preview.providerId,
    endpointOrigin: preview.endpointOrigin,
    endpointIdentitySha256: preview.endpointIdentitySha256,
    transcriptScopeSha256: preview.transcriptScopeSha256,
  };
}

function output() {
  return {
    schemaVersion: "audio_intelligence_output/v1" as const,
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
  };
}

function secretStore() {
  const read = vi.fn(async () => ({
    state: "available" as const,
    secret: "secret",
  }));
  return {
    read,
    port: {
      read,
      replace: vi.fn(async () => undefined),
      delete: vi.fn(async () => "deleted" as const),
      fileVaultStatus: vi.fn(async () => "enabled" as const),
    } satisfies DesktopSecretStorePort,
  };
}

function increasingClock(): () => number {
  let now = 1_000;
  return () => ++now;
}

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
