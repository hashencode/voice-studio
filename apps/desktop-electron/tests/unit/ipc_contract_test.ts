import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  aiProviderProfileSchema,
  aiSettingsSnapshotSchema,
  audioAiConsentIdentitySchema,
  cancelProcessingRequestSchema,
  createAiProviderProfileRequestSchema,
  deleteAiProviderProfileRequestSchema,
  desktopErrorSchema,
  desktopProtocolVersion,
  importAudioResponseSchema,
  ipcChannels,
  microphoneSettingsOpenRequestSchema,
  microphoneTestSnapshotSchema,
  operationEventSchema,
  selectAiProviderProfileRequestSchema,
  updateAiProviderProfileRequestSchema,
  workerHealthRequestSchema,
} from "../../src/shared/contracts/index";
import { createDesktopApi } from "../../src/preload/api";

describe("shared IPC contracts", () => {
  it("strictly validates custom and reserved hosted provider profiles", () => {
    const custom = {
      profileId: "legacy-default",
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
    ).toEqual(expect.objectContaining({ selectedProfileId: "legacy-default" }));
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
      displayName: "团队模型",
      protocol: "openai-compatible" as const,
      modelId: "gpt-compatible",
      endpoint: "https://ai.example.com/v1",
      secret: "sk-create-secret",
    };
    expect(createAiProviderProfileRequestSchema.parse(create)).toEqual(create);
    expect(() =>
      createAiProviderProfileRequestSchema.parse({
        ...create,
        displayName: "   ",
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
        displayName: create.displayName,
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
    const invoke = vi.fn(async () => snapshot);
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
      ...snapshot,
      profiles: [{ ...snapshot.profiles[0], secret: "sk-response-leak" }],
    } as unknown as typeof snapshot);
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
    ).toEqual({ expectedProtocolVersion: 2 });
    expect(() =>
      cancelProcessingRequestSchema.parse({
        jobId: 7,
        path: "/tmp/unauthorized",
      }),
    ).toThrow();
    expect(
      importAudioResponseSchema.parse({
        protocolVersion: 2,
        state: "imported",
        audioId: 3,
        mediaSha256: "a".repeat(64),
        inserted: false,
      }),
    ).toEqual(expect.objectContaining({ state: "imported", inserted: false }));
    expect(() =>
      importAudioResponseSchema.parse({
        protocolVersion: 2,
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
      desktopErrorSchema.parse({
        protocolVersion: 2,
        code: "INVALID_PAYLOAD",
        message: "request rejected",
        retryable: false,
      }),
    ).toEqual(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    expect(() =>
      cancelProcessingRequestSchema.parse({ jobId: 7, args: ["--shell"] }),
    ).toThrow();
    expect(() =>
      operationEventSchema.parse({
        protocolVersion: 2,
        jobId: 7,
        state: "running",
      }),
    ).toThrow();
    expect(
      operationEventSchema.parse({
        protocolVersion: 2,
        jobId: 7,
        attempt: 0,
        state: "running",
      }),
    ).toEqual(
      expect.objectContaining({ jobId: 7, attempt: 0, state: "running" }),
    );
    expect(() =>
      operationEventSchema.parse({
        protocolVersion: 2,
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
    expect(desktopProtocolVersion).toBe(2);
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
          protocolVersion: 2,
          protocol: "desktop-sherpa-worker-health/v1",
          runtime: "sherpa-onnx",
          workerSha256: "a".repeat(64),
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
        protocolVersion: 2,
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
      expect.objectContaining({ protocolVersion: 2 }),
    );
  });
});
