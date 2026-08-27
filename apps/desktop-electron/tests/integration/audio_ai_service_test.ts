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
      profileId: "legacy-default",
      providerDisplayName: "deepseek-chat",
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
      preparationId: preview.preparationId,
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
    new AiJobRepository(database).updateProfile({
      profileId: "legacy-default",
      configurationName: "Changed provider",
      protocol: "openai-compatible",
      modelId: "another-model",
      endpoint: "https://ai.example.com",
      expectedRevision: 0,
      nowMs: 9_999,
    });
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
        preparationId: previous.preparationId,
        idempotencyKey: "ai-generate-title-change-0001",
        consent: consent(previous),
      }),
    ).rejects.toMatchObject({ code: "AI_PREPARATION_STALE" });
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
      preparationId: preview.preparationId,
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
    expect(completed.providerDisplayName).toBe("deepseek-chat");
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
    const secondPreview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const first = service.generate({
      preparationId: preview.preparationId,
      idempotencyKey: "ai-generate-concurrent-0001",
      consent: consent(preview),
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const rejected = await service.generate({
      preparationId: secondPreview.preparationId,
      idempotencyKey: "ai-generate-concurrent-0002",
      consent: consent(secondPreview),
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
      preparationId: preview.preparationId,
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
      preparationId: preview.preparationId,
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

  it("creates isolated profiles, normalizes optional names, and serializes stale mutations before Keychain access", async () => {
    database = openAudioDatabase(":memory:");
    const repository = new AiJobRepository(database);
    const secrets = secretStore();
    const identities = [
      { profileId: "profile-a", secretRef: "secret-a" },
      { profileId: "profile-b", secretRef: "secret-b" },
      { profileId: "profile-c", secretRef: "secret-c" },
    ];
    const service = new AudioAiService(
      repository,
      secrets.port,
      undefined,
      increasingClock(),
      () => identities.shift()!,
    );

    const first = await service.createProfile({
      expectedRevision: 0,
      configurationName: "  Work AI  ",
      protocol: "openai-compatible",
      modelId: "model-a",
      endpoint: "https://ai.example.com/v1",
      secret: "secret-one",
    });
    expect(first.selectedProfileId).toBe("profile-a");
    expect(first.profiles[0]).toMatchObject({
      profileId: "profile-a",
      configurationName: "Work AI",
      displayName: "model-a",
      secretState: "available",
    });
    expect(secrets.replace).toHaveBeenCalledWith("secret-a", "secret-one");

    const second = await service.createProfile({
      expectedRevision: first.revision,
      configurationName: "Second",
      protocol: "openai-compatible",
      modelId: "model-b",
      endpoint: "https://other.example.com/v1",
      secret: "secret-two",
    });
    expect(second.selectedProfileId).toBe("profile-b");
    expect(secrets.replace).toHaveBeenCalledWith("secret-b", "secret-two");
    expect(
      database
        .prepare(
          "SELECT profile_id, secret_ref FROM ai_provider_profiles ORDER BY profile_id",
        )
        .all(),
    ).toEqual([
      { profile_id: "profile-a", secret_ref: "secret-a" },
      { profile_id: "profile-b", secret_ref: "secret-b" },
    ]);

    const selected = second;

    await expect(
      service.createProfile({
        expectedRevision: selected.revision,
        configurationName: "work ai",
        protocol: "openai-compatible",
        modelId: "model-b",
        endpoint: "https://other.example.com/v1",
        secret: "secret-two",
      }),
    ).rejects.toMatchObject({ code: "AI_INVALID_CONFIGURATION" });
    expect(secrets.replace).toHaveBeenCalledTimes(2);

    await expect(
      service.createProfile({
        expectedRevision: selected.revision,
        configurationName: "Invalid DeepSeek",
        protocol: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://other.example.com",
        secret: "must-not-be-written",
      }),
    ).rejects.toMatchObject({ code: "AI_INVALID_CONFIGURATION" });
    expect(secrets.replace).toHaveBeenCalledTimes(2);

    const staleRevision = selected.revision;
    const results = await Promise.allSettled([
      service.updateProfile({
        expectedRevision: staleRevision,
        profileId: "profile-a",
        configurationName: "Work AI updated",
        protocol: "openai-compatible",
        modelId: "model-a2",
        endpoint: "https://ai.example.com/v1",
        secret: "replacement",
      }),
      service.createProfile({
        expectedRevision: staleRevision,
        configurationName: "Third",
        protocol: "openai-compatible",
        modelId: "model-b",
        endpoint: "https://other.example.com/v1",
        secret: "secret-two",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(secrets.replace).toHaveBeenCalledTimes(3);
  });

  it("journals Keychain denial after deleting a non-selected profile", async () => {
    database = openAudioDatabase(":memory:");
    const repository = new AiJobRepository(database);
    repository.createProfile({
      profileId: "older",
      secretRef: "older-secret",
      configurationName: "Older",
      protocol: "openai-compatible",
      modelId: "old-model",
      endpoint: "https://old.example.com",
      expectedRevision: 0,
      nowMs: 1,
    });
    repository.createProfile({
      profileId: "active",
      secretRef: "active-secret",
      configurationName: "Active",
      protocol: "deepseek",
      modelId: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      expectedRevision: 1,
      nowMs: 2,
    });
    const secrets = secretStore();
    secrets.delete
      .mockResolvedValueOnce("denied")
      .mockResolvedValueOnce("missing");
    const service = new AudioAiService(repository, secrets.port);
    const selected = await service.selectProfile({
      expectedRevision: 2,
      profileId: "older",
    });

    const deleted = await service.deleteProfile({
      expectedRevision: selected.revision,
      profileId: "active",
    });
    expect(deleted.selectedProfileId).toBe("older");
    expect(repository.profile("active")).toBeNull();
    expect(repository.secretCleanup.pending()).toEqual([
      expect.objectContaining({
        secretRef: "active-secret",
        state: "failed",
        errorCode: "AI_SECRET_DENIED",
      }),
    ]);
    expect(await service.reconcileSecretCleanup()).toBe(1);
    expect(repository.secretCleanup.pending()).toEqual([]);
  });

  it("rejects edits and deletion for the selected profile", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const secrets = secretStore();
    const service = new AudioAiService(repository, secrets.port);
    await expect(
      service.updateProfile({
        expectedRevision: 0,
        profileId: "legacy-default",
        configurationName: null,
        protocol: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
      }),
    ).rejects.toMatchObject({ code: "AI_PROFILE_IN_USE" });
    await expect(
      service.deleteProfile({
        expectedRevision: 0,
        profileId: "legacy-default",
      }),
    ).rejects.toMatchObject({ code: "AI_PROFILE_IN_USE" });
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it("does not persist create or update configuration when the Keychain write fails", async () => {
    database = openAudioDatabase(":memory:");
    const repository = new AiJobRepository(database);
    repository.createProfile({
      profileId: "existing",
      secretRef: "existing-secret",
      configurationName: "Existing",
      protocol: "openai-compatible",
      modelId: "old-model",
      endpoint: "https://old.example.com",
      expectedRevision: 0,
      nowMs: 1,
    });
    const secrets = secretStore();
    secrets.replace.mockRejectedValue(new Error("KEYCHAIN_UNAVAILABLE"));
    const service = new AudioAiService(
      repository,
      secrets.port,
      undefined,
      increasingClock(),
      () => ({ profileId: "new-profile", secretRef: "new-secret" }),
    );

    await expect(
      service.createProfile({
        expectedRevision: 1,
        configurationName: "New",
        protocol: "openai-compatible",
        modelId: "new-model",
        endpoint: "https://new.example.com",
        secret: "new-key",
      }),
    ).rejects.toThrow("KEYCHAIN_UNAVAILABLE");
    expect(repository.profile("new-profile")).toBeNull();
    expect(repository.settingsRevision()).toBe(1);

    database.exec(
      "UPDATE ai_provider_selection SET selected_profile_id = NULL WHERE id = 1",
    );

    await expect(
      service.updateProfile({
        expectedRevision: 1,
        profileId: "existing",
        configurationName: "Changed",
        protocol: "openai-compatible",
        modelId: "changed-model",
        endpoint: "https://changed.example.com",
        secret: "replacement",
      }),
    ).rejects.toThrow("KEYCHAIN_UNAVAILABLE");
    expect(repository.profile("existing")).toMatchObject({
      configurationName: "Existing",
      modelId: "old-model",
      endpoint: "https://old.example.com",
    });
    expect(repository.settingsRevision()).toBe(1);
  });

  it("compensates Keychain mutations when the matching SQLite write fails", async () => {
    database = openAudioDatabase(":memory:");
    const repository = new AiJobRepository(database);
    repository.createProfile({
      profileId: "existing",
      secretRef: "existing-secret",
      configurationName: "Existing",
      protocol: "openai-compatible",
      modelId: "old-model",
      endpoint: "https://old.example.com",
      expectedRevision: 0,
      nowMs: 1,
    });
    const secrets = secretStore();
    const service = new AudioAiService(
      repository,
      secrets.port,
      undefined,
      increasingClock(),
      () => ({ profileId: "new-profile", secretRef: "new-secret" }),
    );

    vi.spyOn(repository, "createProfile").mockImplementationOnce(() => {
      throw new Error("SQLITE_CREATE_FAILED");
    });
    await expect(
      service.createProfile({
        expectedRevision: 1,
        configurationName: "New",
        protocol: "openai-compatible",
        modelId: "new-model",
        endpoint: "https://new.example.com",
        secret: "new-key",
      }),
    ).rejects.toThrow("SQLITE_CREATE_FAILED");
    expect(secrets.replace).toHaveBeenCalledWith("new-secret", "new-key");
    expect(secrets.delete).toHaveBeenCalledWith("new-secret");
    expect(repository.profile("new-profile")).toBeNull();

    database.exec(
      "UPDATE ai_provider_selection SET selected_profile_id = NULL WHERE id = 1",
    );

    secrets.replace.mockClear();
    vi.spyOn(repository, "updateProfile").mockImplementationOnce(() => {
      throw new Error("SQLITE_UPDATE_FAILED");
    });
    await expect(
      service.updateProfile({
        expectedRevision: 1,
        profileId: "existing",
        configurationName: "Changed",
        protocol: "openai-compatible",
        modelId: "changed-model",
        endpoint: "https://changed.example.com",
        secret: "replacement",
      }),
    ).rejects.toThrow("SQLITE_UPDATE_FAILED");
    expect(secrets.replace.mock.calls).toEqual([["new-secret", "replacement"]]);
    expect(secrets.delete).toHaveBeenCalledWith("new-secret");
    expect(repository.profile("existing")).toMatchObject({
      configurationName: "Existing",
      modelId: "old-model",
    });
  });

  it("blocks secret mutation while retryable work exists and preserves history after completion", async () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new AiJobRepository(database);
    const secrets = secretStore();
    const configs: Array<Record<string, unknown>> = [];
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new AiProviderFailure("AI_SERVICE_UNAVAILABLE", "down"),
      )
      .mockResolvedValueOnce(output());
    const service = new AudioAiService(
      repository,
      secrets.port,
      (config) => {
        configs.push({ ...config });
        return { id: config.providerId, generate };
      },
      increasingClock(),
    );
    const preview = service.prepare({
      audioId: 1,
      generationId: 1,
      templateId: "default",
    });
    const failed = await service.generate({
      preparationId: preview.preparationId,
      idempotencyKey: "immutable-profile-generate",
      consent: consent(preview),
    });
    const current = await service.createProfile({
      expectedRevision: 0,
      configurationName: "Current",
      protocol: "openai-compatible",
      modelId: "current-model",
      endpoint: "https://current.example.com",
      secret: "current-secret",
    });
    await expect(
      service.updateProfile({
        profileId: "legacy-default",
        configurationName: "Changed",
        protocol: "openai-compatible",
        modelId: "changed-model",
        endpoint: "https://changed.example.com",
        expectedRevision: current.revision,
        secret: "changed-secret",
      }),
    ).rejects.toMatchObject({ code: "AI_SECRET_IN_USE" });

    const completed = await service.retry({
      jobId: failed.jobId,
      expectedAttempt: failed.attempt,
      idempotencyKey: "immutable-profile-retry",
      consent: consent(preview),
    });
    expect(completed.state).toBe("completed");
    expect(completed.providerDisplayName).toBe("deepseek-chat");
    const updated = await service.updateProfile({
      profileId: "legacy-default",
      configurationName: "Changed",
      protocol: "openai-compatible",
      modelId: "changed-model",
      endpoint: "https://changed.example.com",
      expectedRevision: current.revision,
      secret: "changed-secret",
    });
    await service.deleteProfile({
      profileId: "legacy-default",
      expectedRevision: updated.revision,
    });
    expect(service.snapshot(1)?.providerDisplayName).toBe("deepseek-chat");
    expect(configs).toEqual([
      expect.objectContaining({
        providerId: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        secretRef: "deepseek",
      }),
      expect.objectContaining({
        providerId: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        secretRef: "deepseek",
      }),
    ]);
  });

  it("fails prepare before network access when no profile is selected", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database, false);
    const generate = vi.fn();
    const service = new AudioAiService(
      new AiJobRepository(database),
      secretStore().port,
      () => ({ id: "deepseek", generate }),
    );
    expect(() =>
      service.prepare({ audioId: 1, generationId: 1, templateId: "default" }),
    ).toThrowError(expect.objectContaining({ code: "AI_PROVIDER_MISSING" }));
    expect(generate).not.toHaveBeenCalled();
  });
});

function consent(preview: ReturnType<AudioAiService["prepare"]>) {
  return {
    version: 1 as const,
    profileId: preview.profileId,
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
  const replace = vi.fn(async () => undefined);
  const deleteSecret = vi.fn<DesktopSecretStorePort["delete"]>(async () =>
    Promise.resolve("deleted"),
  );
  return {
    read,
    replace,
    delete: deleteSecret,
    port: {
      read,
      replace,
      delete: deleteSecret,
      fileVaultStatus: vi.fn(async () => "enabled" as const),
    } satisfies DesktopSecretStorePort,
  };
}

function increasingClock(): () => number {
  let now = 1_000;
  return () => ++now;
}

function seedAudio(database: DatabaseSync, withProfile = true): void {
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
  if (withProfile) {
    database.exec(`
      INSERT INTO ai_provider_profiles (
        profile_id, kind, configuration_name, protocol,
        model_id, endpoint, secret_ref, created_at_ms, updated_at_ms, revision
      ) VALUES (
        'legacy-default', 'custom', 'DeepSeek', 'deepseek',
        'deepseek-chat', 'https://api.deepseek.com', 'deepseek', 0, 0, 0
      );
      UPDATE ai_provider_selection
        SET selected_profile_id = 'legacy-default' WHERE id = 1;
    `);
  }
}
