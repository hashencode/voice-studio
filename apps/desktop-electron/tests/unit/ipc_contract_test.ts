import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  aiProviderProfileSchema,
  aiSettingsSnapshotSchema,
  audioAiConsentIdentitySchema,
  audioAiConsentPreviewSchema,
  audioAiSnapshotSchema,
  bootstrapActionRequestSchema,
  cancelProcessingRequestSchema,
  captureAudioActivitySchema,
  captureRecoveryActionRequestSchema,
  captureRecoveryActionResponseSchema,
  captureRecoveryItemSchema,
  captureRuntimeSnapshotSchema,
  captureSnapshotSchema,
  captureLibraryProjectionRetryRequestSchema,
  applicationSnapshotSchema,
  createAiProviderProfileRequestSchema,
  deleteAiProviderProfileRequestSchema,
  desktopFailureSchema,
  desktopIpcFailureEnvelopeSchema,
  desktopIpcSuccessEnvelopeSchema,
  desktopProtocolVersion,
  importAudioResponseSchema,
  ipcChannels,
  microphoneSettingsOpenRequestSchema,
  microphoneTestSnapshotSchema,
  operationEventSchema,
  renameCaptureSessionRequestSchema,
  selectAiProviderProfileRequestSchema,
  suggestCaptureTitleResponseSchema,
  updateAiProviderProfileRequestSchema,
  workerHealthRequestSchema,
  workerHealthResponseSchema,
} from "../../src/shared/contracts/index";
import { createDesktopApi } from "../../src/preload/api";

describe("shared IPC contracts", () => {
  it("validates capture library projection retry through preload", async () => {
    const snapshot = applicationSnapshotSchema.parse({
      protocolVersion: desktopProtocolVersion,
      revision: 3,
      navigation: { section: "library" },
      profile: { phase: "initializing" },
      connectivity: "online",
      capability: { processing: "available" },
      library: { phase: "empty" },
      reconciliation: [],
      capture: { phase: "idle" },
      libraryProjection: {
        phase: "registered",
        sessionId: "session-retry-123456",
        intentId: "intent-retry-next-123456",
        audioId: 4,
      },
      activity: [],
    });
    const invoke = vi.fn(async () => ({ ok: true, value: snapshot }));
    const api = createDesktopApi({ invoke, on: vi.fn(), off: vi.fn() });

    await expect(
      api.retryCaptureLibraryProjection!({
        sessionId: "session-retry-123456",
        intentId: "intent-retry-failed-123456",
      }),
    ).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith(
      ipcChannels.captureLibraryProjectionRetry,
      {
        sessionId: "session-retry-123456",
        intentId: "intent-retry-failed-123456",
      },
    );
    expect(() =>
      captureLibraryProjectionRetryRequestSchema.parse({
        sessionId: "session-retry-123456",
        intentId: " ",
      }),
    ).toThrow();
  });

  it("carries authoritative recovery capabilities and ordered batch outcomes through preload", async () => {
    const sessionId = "session-contract-recovery-123456";
    const recovery = captureRecoveryItemSchema.parse({
      sessionId,
      state: "recoverable",
      captureMode: "microphone_only",
      captureTimelineMs: 0,
      systemAudioHealthy: false,
      microphoneHealthy: false,
      partialCapture: false,
      finalizedChunkCount: 0,
      eventCount: 0,
      gapCount: 0,
      interruptionReason: null,
      recordingSha256: null,
      journalSha256: "a".repeat(64),
      title: "Recovery",
      capability: "discard-only",
      reason: "no-audio-data",
    });
    const response = captureRecoveryActionResponseSchema.parse({
      outcomes: [
        {
          sessionId,
          action: "discard",
          result: "discarded",
          completionCertainty: "completed",
          audioDurability: "discarded",
          transcriptionHandoff: "not-requested",
          capture: null,
        },
      ],
      recoveries: [],
    });
    const invoke = vi.fn(async () => ({ ok: true, value: response }));
    const api = createDesktopApi({ invoke, on: vi.fn(), off: vi.fn() });

    await expect(
      api.actOnCaptureRecovery({
        action: "discard",
        intent: "automatic-discard-only-cleanup",
        sessionIds: [sessionId],
        idempotencyKey: "discard-contract-123456",
      }),
    ).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith(ipcChannels.captureRecoveryAction, {
      action: "discard",
      intent: "automatic-discard-only-cleanup",
      sessionIds: [sessionId],
      idempotencyKey: "discard-contract-123456",
    });
    expect(() =>
      captureRecoveryActionRequestSchema.parse({
        action: "keep",
        intent: "user-decision",
        sessionIds: [sessionId, sessionId],
        idempotencyKey: "keep-duplicate-123456",
      }),
    ).toThrow();
    expect(() =>
      captureRecoveryActionRequestSchema.parse({
        action: "keep",
        intent: "automatic-discard-only-cleanup",
        sessionIds: [sessionId],
        idempotencyKey: "keep-automatic-123456",
      }),
    ).toThrow();
    expect(() =>
      captureRecoveryItemSchema.parse({
        ...recovery,
        capability: "preserve-only",
        reason: null,
      }),
    ).toThrow();
  });
  it("validates capture naming and keeps runtime activity ephemeral", () => {
    const sessionId = "session-capture-123456";
    expect(
      renameCaptureSessionRequestSchema.parse({
        sessionId,
        title: "  产品回访  ",
      }),
    ).toEqual({ sessionId, title: "产品回访" });
    for (const invalid of [
      { sessionId: "bad", title: "产品回访" },
      { sessionId, title: "" },
      { sessionId, title: "   " },
      { sessionId, title: "x".repeat(257) },
    ]) {
      expect(() => renameCaptureSessionRequestSchema.parse(invalid)).toThrow();
    }

    expect(
      suggestCaptureTitleResponseSchema.parse({ title: "新录音2026070101" }),
    ).toEqual({ title: "新录音2026070101" });
    expect(() =>
      suggestCaptureTitleResponseSchema.parse({ title: "" }),
    ).toThrow();
    expect(() =>
      suggestCaptureTitleResponseSchema.parse({ title: "x".repeat(257) }),
    ).toThrow();

    const durable = {
      sessionId,
      state: "recording" as const,
      captureMode: "dual_track" as const,
      captureTimelineMs: 1_000,
      systemAudioHealthy: true,
      microphoneHealthy: true,
      partialCapture: false,
      finalizedChunkCount: 0,
      eventCount: 0,
      gapCount: 0,
      interruptionReason: null,
      recordingSha256: null,
    };
    expect(captureSnapshotSchema.parse(durable)).toEqual(durable);
    expect(() =>
      captureSnapshotSchema.parse({ ...durable, audioActivity: 0.5 }),
    ).toThrow();
    expect(
      captureRuntimeSnapshotSchema.parse({ ...durable, audioActivity: 0.5 }),
    ).toMatchObject({ audioActivity: 0.5 });
    for (const value of [0, 1]) {
      expect(captureAudioActivitySchema.parse(value)).toBe(value);
    }
    for (const value of [Number.NaN, -0.01, 1.01]) {
      expect(() => captureAudioActivitySchema.parse(value)).toThrow();
    }

    const baseApplication = {
      protocolVersion: 3 as const,
      revision: 1,
      navigation: { section: "library" as const },
      profile: { phase: "ready" as const, legacyDatabaseArchived: false },
      connectivity: "online" as const,
      capability: { processing: "available" as const },
      library: { phase: "empty" as const },
      reconciliation: [],
    };
    expect(
      applicationSnapshotSchema.parse({
        ...baseApplication,
        capture: {
          phase: "recording",
          sessionId,
          title: "产品回访",
          elapsedMs: 1_000,
          audioActivity: 1,
        },
      }).capture,
    ).toMatchObject({ audioActivity: 1 });
    expect(() =>
      applicationSnapshotSchema.parse({
        ...baseApplication,
        capture: { phase: "idle", audioActivity: 0 },
      }),
    ).toThrow();
  });

  it("validates capture naming requests and responses in preload", async () => {
    const invoke = vi.fn(async (channel: string) => ({
      ok: true,
      value:
        channel === ipcChannels.captureTitleSuggest
          ? { title: "新录音2026070101" }
          : {
              protocolVersion: 3,
              revision: 2,
              navigation: { section: "library" },
              profile: { phase: "ready", legacyDatabaseArchived: false },
              connectivity: "online",
              capability: { processing: "available" },
              library: { phase: "empty" },
              reconciliation: [],
              capture: { phase: "idle" },
            },
    }));
    const api = createDesktopApi({ invoke, on: vi.fn(), off: vi.fn() });

    await expect(api.suggestCaptureTitle()).resolves.toEqual({
      title: "新录音2026070101",
    });
    await expect(
      api.renameCaptureSession({
        sessionId: "session-capture-123456",
        title: "  产品回访  ",
      }),
    ).resolves.toMatchObject({ revision: 2 });
    expect(invoke).toHaveBeenLastCalledWith(ipcChannels.captureSessionRename, {
      sessionId: "session-capture-123456",
      title: "产品回访",
    });

    await expect(
      api.renameCaptureSession({
        sessionId: "bad",
        title: "产品回访",
      }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);

    invoke.mockResolvedValueOnce({ ok: true, value: { title: "" } } as never);
    await expect(api.suggestCaptureTitle()).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ok: true,
      value: { revision: 3 },
    } as never);
    await expect(
      api.renameCaptureSession({
        sessionId: "session-capture-123456",
        title: "产品回访",
      }),
    ).rejects.toThrow();
  });

  it("exposes recheck as the only application bootstrap action", () => {
    expect(bootstrapActionRequestSchema.parse({ action: "recheck" })).toEqual({
      action: "recheck",
    });
    expect(() =>
      bootstrapActionRequestSchema.parse({ action: "repair-guidance" }),
    ).toThrow();
    expect(() =>
      bootstrapActionRequestSchema.parse({ action: "retry" }),
    ).toThrow();
  });

  it("strictly validates custom and reserved hosted provider profiles", () => {
    const custom = {
      profileId: "profile-deepseek",
      kind: "custom" as const,
      displayName: "DeepSeek",
      protocol: "deepseek" as const,
      modelId: "deepseek-chat",
      modelSummary: "deepseek-chat",
      endpoint: "https://api.deepseek.com/v1",
      endpointOrigin: "https://api.deepseek.com",
      processingLocation: "cloudDirect" as const,
      requiresConsent: true as const,
      capabilities: {
        selectable: true as const,
        editable: true as const,
        deletable: true as const,
      },
      secretState: "available" as const,
    };
    expect(aiProviderProfileSchema.parse(custom)).toEqual(custom);
    expect(
      aiSettingsSnapshotSchema.parse({
        revision: 3,
        profiles: [custom],
        selectedProfileId: custom.profileId,
        deviceSecurity: {
          kind: "device-security",
          fileVaultState: "unknown",
          applicationLayerEncryption: "not-claimed",
        },
      }),
    ).toEqual(
      expect.objectContaining({ selectedProfileId: "profile-deepseek" }),
    );
    expect(() =>
      aiProviderProfileSchema.parse({ ...custom, secretRef: "deepseek" }),
    ).toThrow();
    expect(() =>
      aiProviderProfileSchema.parse({ ...custom, secret: "sk-response-leak" }),
    ).toThrow();

    const hosted = {
      profileId: "hosted-default",
      kind: "hosted" as const,
      displayName: "内置模型",
      modelSummary: "会员云端模型",
      processingLocation: "cloudHosted" as const,
      requiresConsent: true as const,
      capabilities: {
        selectable: true as const,
        editable: false as const,
        deletable: false as const,
      },
    };
    expect(aiProviderProfileSchema.parse(hosted)).toEqual(hosted);
    expect(() =>
      aiProviderProfileSchema.parse({
        ...hosted,
        modelId: "private-upstream-model",
      }),
    ).toThrow();
    expect(() =>
      aiProviderProfileSchema.parse({
        ...hosted,
        endpoint: "https://platform.invalid/v1",
      }),
    ).toThrow();
  });

  it("validates revision-checked provider profile mutations", () => {
    const create = {
      expectedRevision: 0,
      protocol: "openai-compatible" as const,
      modelId: "gpt-compatible",
      endpoint: "https://ai.example.com/v1",
      secret: "sk-create-secret",
    };
    expect(createAiProviderProfileRequestSchema.parse(create)).toEqual(create);
    expect(() =>
      createAiProviderProfileRequestSchema.parse({
        ...create,
        unknownField: true,
      }),
    ).toThrow();
    expect(() =>
      createAiProviderProfileRequestSchema.parse({
        ...create,
        modelId: "   ",
      }),
    ).toThrow();
    expect(() =>
      createAiProviderProfileRequestSchema.parse({
        ...create,
        endpoint: "not-a-url",
      }),
    ).toThrow();
    expect(() =>
      createAiProviderProfileRequestSchema.parse({
        ...create,
        expectedRevision: undefined,
      }),
    ).toThrow();

    expect(
      updateAiProviderProfileRequestSchema.parse({
        ...create,
        expectedRevision: 1,
        profileId: "profile-123",
        secret: undefined,
      }),
    ).toHaveProperty("secret", undefined);
    expect(
      updateAiProviderProfileRequestSchema.parse({
        protocol: create.protocol,
        modelId: create.modelId,
        endpoint: create.endpoint,
        expectedRevision: 1,
        profileId: "profile-123",
      }),
    ).not.toHaveProperty("secret");
    expect(() =>
      selectAiProviderProfileRequestSchema.parse({
        profileId: "contains space",
        expectedRevision: 1,
      }),
    ).toThrow();
    expect(() =>
      deleteAiProviderProfileRequestSchema.parse({
        profileId: "profile-123",
      }),
    ).toThrow();
  });

  it("binds AI consent to the stable provider profile identity", () => {
    const consent = {
      version: 1 as const,
      profileId: "profile-123",
      providerId: "openai-compatible" as const,
      endpointOrigin: "https://ai.example.com",
      endpointIdentitySha256: "a".repeat(64),
      transcriptScopeSha256: "b".repeat(64),
    };
    expect(audioAiConsentIdentitySchema.parse(consent)).toEqual(consent);
    expect(() =>
      audioAiConsentIdentitySchema.parse({
        ...consent,
        profileId: undefined,
      }),
    ).toThrow();
  });

  it("requires a bounded provider display snapshot outside consent identity", () => {
    const identity = {
      providerId: "openai-compatible" as const,
      endpointOrigin: "https://ai.example.com",
      endpointIdentitySha256: "a".repeat(64),
      transcriptScopeSha256: "b".repeat(64),
    };
    const preview = {
      preparationId: "123e4567-e89b-12d3-a456-426614174000",
      expiresAtMs: 10_000,
      audioId: 1,
      generationId: 2,
      profileId: "profile-123",
      providerDisplayName: "团队模型",
      ...identity,
      modelId: "team-chat",
      audioTitle: "周会",
      segmentCount: 1,
      inputStartMs: 0,
      inputEndMs: 1_000,
      requiresConsent: true as const,
    };
    expect(audioAiConsentPreviewSchema.parse(preview)).toEqual(preview);
    expect(() =>
      audioAiConsentPreviewSchema.parse({
        ...preview,
        providerDisplayName: " ",
      }),
    ).toThrow();

    const snapshot = {
      revision: 1,
      jobId: 3,
      audioId: preview.audioId,
      generationId: preview.generationId,
      providerDisplayName: preview.providerDisplayName,
      ...identity,
      modelId: preview.modelId,
      attempt: 0,
      state: "queued" as const,
      errorCode: null,
      note: null,
    };
    expect(audioAiSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      audioAiSnapshotSchema.parse({
        ...snapshot,
        providerDisplayName: "x".repeat(129),
      }),
    ).toThrow();
  });

  it("validates profile requests and responses at the preload boundary", async () => {
    const snapshot = {
      revision: 1,
      profiles: [
        {
          profileId: "profile-123",
          kind: "custom" as const,
          displayName: "团队模型",
          protocol: "openai-compatible" as const,
          modelId: "gpt-compatible",
          modelSummary: "gpt-compatible",
          endpoint: "https://ai.example.com/v1",
          endpointOrigin: "https://ai.example.com",
          processingLocation: "cloudDirect" as const,
          requiresConsent: true as const,
          capabilities: {
            selectable: true as const,
            editable: true as const,
            deletable: true as const,
          },
          secretState: "available" as const,
        },
      ],
      selectedProfileId: "profile-123",
      deviceSecurity: {
        kind: "device-security" as const,
        fileVaultState: "enabled" as const,
        applicationLayerEncryption: "not-claimed" as const,
      },
    };
    const invoke = vi.fn(async () => ({ ok: true, value: snapshot }));
    const api = createDesktopApi({
      invoke,
      on: vi.fn(),
      off: vi.fn(),
    });

    await expect(
      api.selectAiProviderProfile({
        profileId: "profile-123",
        expectedRevision: 0,
      }),
    ).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith(
      ipcChannels.aiProviderProfileSelect,
      { profileId: "profile-123", expectedRevision: 0 },
    );

    invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        ...snapshot,
        profiles: [{ ...snapshot.profiles[0], secret: "sk-response-leak" }],
      },
    } as never);
    await expect(api.getAiSettings()).rejects.toThrow();
  });

  it("keeps continuous microphone outcomes typed without a renderer URL", () => {
    expect(
      microphoneTestSnapshotSchema.parse({
        testId: "mic-test-contract-123456",
        state: "running",
        elapsedMs: 31_000,
        normalizedRMS: 0.01,
        normalizedPeak: 0.5,
        observedFrames: 1_024,
        observedSound: true,
      }),
    ).toEqual(expect.objectContaining({ state: "running", elapsedMs: 31_000 }));
    expect(() =>
      microphoneTestSnapshotSchema.parse({
        testId: "mic-test-contract-123456",
        state: "unknown",
        elapsedMs: 30_000,
        normalizedRMS: 0,
        normalizedPeak: 0,
        observedFrames: 0,
        observedSound: false,
      }),
    ).toThrow();
    expect(
      microphoneTestSnapshotSchema.parse({
        testId: "mic-test-contract-123456",
        state: "failed",
        reason: "device-unavailable",
        diagnostic: "selected_device_inactive",
        elapsedMs: 1_000,
        normalizedRMS: 0,
        normalizedPeak: 0,
        observedFrames: 0,
        observedSound: false,
      }),
    ).toEqual(
      expect.objectContaining({ diagnostic: "selected_device_inactive" }),
    );
    expect(() =>
      microphoneTestSnapshotSchema.parse({
        testId: "mic-test-contract-123456",
        state: "failed",
        reason: "device-unavailable",
        diagnostic: "CoreAudio device /private/path uid=secret",
        elapsedMs: 1_000,
        normalizedRMS: 0,
        normalizedPeak: 0,
        observedFrames: 0,
        observedSound: false,
      }),
    ).toThrow();
    expect(() =>
      microphoneTestSnapshotSchema.parse({
        testId: "mic-test-contract-123456",
        state: "running",
        diagnostic: "recovery_restart_failed",
        elapsedMs: 1_000,
        normalizedRMS: 0,
        normalizedPeak: 0,
        observedFrames: 0,
        observedSound: false,
      }),
    ).toThrow();
    expect(microphoneSettingsOpenRequestSchema.parse({})).toEqual({});
    expect(() =>
      microphoneSettingsOpenRequestSchema.parse({
        url: "https://example.invalid",
      }),
    ).toThrow();
  });

  it("stay runtime validated and independent of Electron and Node", () => {
    expect(
      workerHealthRequestSchema.parse({
        expectedProtocolVersion: desktopProtocolVersion,
      }),
    ).toEqual({ expectedProtocolVersion: 3 });
    expect(() =>
      cancelProcessingRequestSchema.parse({
        jobId: 7,
        path: "/tmp/unauthorized",
      }),
    ).toThrow();
    expect(
      importAudioResponseSchema.parse({
        protocolVersion: 3,
        state: "imported",
        audioId: 3,
        mediaSha256: "a".repeat(64),
        inserted: false,
      }),
    ).toEqual(expect.objectContaining({ state: "imported", inserted: false }));
    expect(() =>
      importAudioResponseSchema.parse({
        protocolVersion: 3,
        state: "queued",
        audioId: 3,
        jobId: 7,
        mediaSha256: "a".repeat(64),
        inserted: true,
        progressFraction: 0,
        attempt: 0,
      }),
    ).toThrow();
    expect(
      desktopFailureSchema.parse({
        protocolVersion: 3,
        domain: "local-model",
        code: "MODEL_BUSY",
        retryable: true,
        fallback: "try-again",
      }),
    ).toEqual(expect.objectContaining({ code: "MODEL_BUSY" }));
    expect(() =>
      cancelProcessingRequestSchema.parse({ jobId: 7, args: ["--shell"] }),
    ).toThrow();
    expect(() =>
      operationEventSchema.parse({
        protocolVersion: 3,
        jobId: 7,
        state: "running",
      }),
    ).toThrow();
    expect(
      operationEventSchema.parse({
        protocolVersion: 3,
        jobId: 7,
        attempt: 0,
        state: "running",
      }),
    ).toEqual(
      expect.objectContaining({ jobId: 7, attempt: 0, state: "running" }),
    );
    expect(() =>
      operationEventSchema.parse({
        protocolVersion: 3,
        jobId: 7,
        attempt: 2,
        state: "running",
        rawEvent: {},
      }),
    ).toThrow();

    const sharedRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/shared/contracts",
    );
    for (const file of ["index.ts", "ipc.ts", "worker_protocol.ts"]) {
      const source = readFileSync(join(sharedRoot, file), "utf8");
      expect(source).not.toMatch(/from ["'](?:electron|node:)/);
    }
  });

  it("maps fixed business methods and returns an unsubscribe per event listener", async () => {
    expect(desktopProtocolVersion).toBe(3);
    expect(Object.keys(ipcChannels).some((key) => /meeting/i.test(key))).toBe(
      false,
    );
    expect(
      Object.values(ipcChannels).some((channel) => /meeting/i.test(channel)),
    ).toBe(false);
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const bridge = {
      invoke: async (channel: string) => {
        expect(Object.values(ipcChannels)).toContain(channel);
        return {
          ok: true,
          value: {
            protocolVersion: 3,
            protocol: "desktop-sherpa-worker-health/v1",
            runtime: "sherpa-onnx",
            workerSha256: "a".repeat(64),
          },
        };
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
      },
      off: (channel: string, listener: (payload: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      },
    };
    const firstApi = createDesktopApi(bridge);
    const secondApi = createDesktopApi(bridge);
    const received: number[] = [];
    const unsubscribeFirst = firstApi.onOperationEvent((event) =>
      received.push(event.jobId),
    );
    const unsubscribeSecond = secondApi.onOperationEvent((event) =>
      received.push(event.jobId),
    );

    expect(listeners.get(ipcChannels.operationEvent)?.size).toBe(2);
    for (const listener of listeners.get(ipcChannels.operationEvent) ?? []) {
      listener({
        protocolVersion: 3,
        jobId: 11,
        attempt: 1,
        state: "running",
      });
    }
    expect(received).toEqual([11, 11]);

    unsubscribeFirst();
    unsubscribeFirst();
    expect(listeners.get(ipcChannels.operationEvent)?.size).toBe(1);
    unsubscribeSecond();
    expect(listeners.get(ipcChannels.operationEvent)?.size).toBe(0);
    await expect(firstApi.workerHealth()).resolves.toEqual(
      expect.objectContaining({ protocolVersion: 3 }),
    );
  });

  it("unwraps typed success and rejects only schema-validated safe failures", async () => {
    const safeFailure = desktopFailureSchema.parse({
      protocolVersion: 3,
      domain: "local-model",
      code: "MODEL_BUSY",
      retryable: true,
      fallback: "try-again",
    });
    expect(
      desktopIpcSuccessEnvelopeSchema(workerHealthResponseSchema).parse({
        ok: true,
        value: {
          protocolVersion: 3,
          protocol: "desktop-sherpa-worker-health/v1",
          runtime: "sherpa-onnx",
          workerSha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      desktopIpcFailureEnvelopeSchema.parse({
        ok: false,
        failure: safeFailure,
      }),
    ).toEqual({ ok: false, failure: safeFailure });

    const bridge = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, failure: safeFailure })
        .mockResolvedValueOnce({
          ok: false,
          failure: {
            ...safeFailure,
            code: "UNKNOWN_PRIVATE_CODE",
            message: "/Users/private/secret.wav",
          },
        })
        .mockRejectedValueOnce(
          new Error("socket closed at /Users/private/secret.wav"),
        )
        .mockResolvedValueOnce({
          ok: true,
          value: { protocolVersion: 3, protocol: "malformed" },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            protocolVersion: 2,
            protocol: "desktop-sherpa-worker-health/v1",
            runtime: "sherpa-onnx",
            workerSha256: "a".repeat(64),
          },
        }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const api = createDesktopApi(bridge);

    await expect(api.workerHealth()).rejects.toMatchObject(safeFailure);
    await expect(api.workerHealth()).rejects.toMatchObject({
      domain: "transport",
      code: "INVALID_RESPONSE",
      retryable: true,
      fallback: "try-again",
    });
    await expect(api.workerHealth()).rejects.toMatchObject({
      domain: "transport",
      code: "IPC_DISCONNECTED",
      retryable: true,
      fallback: "try-again",
    });
    await expect(api.workerHealth()).rejects.toMatchObject({
      domain: "transport",
      code: "INVALID_RESPONSE",
      retryable: true,
      fallback: "try-again",
    });
    await expect(api.workerHealth()).rejects.toMatchObject({
      domain: "transport",
      code: "PROTOCOL_MISMATCH",
      retryable: true,
      fallback: "restart-application",
    });
  });
});
