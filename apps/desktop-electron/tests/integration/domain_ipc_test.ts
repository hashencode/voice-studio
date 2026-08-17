import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../src/shared/contracts/index";
import {
  IpcContractError,
  createDesktopIpcHandlers,
} from "../../src/main/ipc/desktop_ipc";
import { createDesktopApi } from "../../src/preload/api";

const trustedEvent = {
  senderId: 41,
  frameId: 9,
  origin: "http://localhost:5173",
};

function handlers() {
  const workerHealth = vi.fn(async () => ({
    protocolVersion: 2 as const,
    protocol: "desktop-sherpa-worker-health/v1" as const,
    runtime: "sherpa-onnx" as const,
    workerSha256: "b".repeat(64),
  }));
  const cancelProcessing = vi.fn(async (jobId: number) => ({
    protocolVersion: 2 as const,
    jobId,
    state: "canceled" as const,
  }));
  const openAudio = vi.fn(async () => null);
  return {
    cancelProcessing,
    handlers: createDesktopIpcHandlers({
      trust: {
        senderId: trustedEvent.senderId,
        frameId: trustedEvent.frameId,
        origins: new Set([trustedEvent.origin]),
      },
      services: {
        getCompanionSnapshot: vi.fn(),
        setCompanionOptIn: vi.fn(),
        createCompanionPairingInvite: vi.fn(),
        revokeCompanionPeer: vi.fn(),
        cancelCompanionTransfer: vi.fn(),
        retryCompanionTransfer: vi.fn(),
        getAiSettings: vi.fn(),
        saveAiSettings: vi.fn(),
        replaceAiProviderSecret: vi.fn(),
        deleteAiProviderSecret: vi.fn(),
        prepareAudioAi: vi.fn(),
        getAudioAiSnapshot: vi.fn(async () => null),
        generateAudioAi: vi.fn(),
        retryAudioAi: vi.fn(),
        applicationSnapshot: () => applicationSnapshot(),
        navigate: (section) => ({
          ...applicationSnapshot(),
          navigation: { section },
        }),
        requestBootstrapAction: async () => applicationSnapshot(),
        workerHealth,
        cancelProcessing,
        retryProcessing: vi.fn(async (jobId: number) => ({
          protocolVersion: 2 as const,
          jobId,
          state: "queued" as const,
        })),
        listProcessingTasks: vi.fn(async () => []),
        importAudio: vi.fn(async () => ({
          protocolVersion: 2 as const,
          state: "canceled" as const,
        })),
        preflightCapture: vi.fn(),
        startCapture: vi.fn(),
        controlCapture: vi.fn(),
        listCaptureRecoveries: vi.fn(async () => []),
        actOnCaptureRecovery: vi.fn(),
        getCaptionSnapshot: vi.fn(async () => null),
        retryFormalTranscript: vi.fn(),
        listAudios: vi.fn(async () => []),
        openAudio,
        searchTranscript: vi.fn(async () => []),
        editAudioSegment: vi.fn(),
        undoAudioEdit: vi.fn(),
        redoAudioEdit: vi.fn(),
        renameAudioSpeaker: vi.fn(),
        mergeAudioSpeakers: vi.fn(),
        assignAudioSpeaker: vi.fn(),
        controlAudioPlayback: vi.fn(),
        exportAudio: vi.fn(),
      },
      maximumPayloadBytes: 1024,
    }),
    workerHealth,
    openAudio,
  };
}

describe("Main IPC validation", () => {
  it("rejects raw capture paths before they reach Main services", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.captureStart, trustedEvent, {
        title: "音频",
        captionEnabled: false,
        idempotencyKey: "capture-start-123456",
        sessionRoot: "/tmp/renderer-controlled",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("rejects unknown channels, sender/frame/origin failures, and invalid payloads before services", async () => {
    const fixture = handlers();
    expect(fixture.handlers.has("desktop.raw.process.spawn")).toBe(false);

    for (const event of [
      { ...trustedEvent, senderId: 42 },
      { ...trustedEvent, frameId: 10 },
      { ...trustedEvent, origin: "https://attacker.invalid" },
    ]) {
      await expect(
        fixture.handlers.invoke(ipcChannels.workerHealth, event, {
          expectedProtocolVersion: 2,
        }),
      ).rejects.toBeInstanceOf(IpcContractError);
    }
    await expect(
      fixture.handlers.invoke(ipcChannels.cancelProcessing, trustedEvent, {
        jobId: 1,
        path: "/etc/passwd",
      }),
    ).rejects.toBeInstanceOf(IpcContractError);
    await expect(
      fixture.handlers.invoke(ipcChannels.cancelProcessing, trustedEvent, {
        jobId: 1,
        args: ["--execute", "anything"],
      }),
    ).rejects.toBeInstanceOf(IpcContractError);
    expect(fixture.workerHealth).not.toHaveBeenCalled();
    expect(fixture.cancelProcessing).not.toHaveBeenCalled();
  });

  it("rejects Meeting-era IPC before any Audio mutation service runs", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke("desktop.meetings.open.v1", trustedEvent, {
        meetingId: 7,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_CHANNEL" });
    expect(fixture.openAudio).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-serializable payloads before services", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.cancelProcessing, trustedEvent, {
        jobId: 1,
        padding: "x".repeat(2048),
      }),
    ).rejects.toBeInstanceOf(IpcContractError);
    const cyclic: Record<string, unknown> = { jobId: 1 };
    cyclic.self = cyclic;
    await expect(
      fixture.handlers.invoke(
        ipcChannels.cancelProcessing,
        trustedEvent,
        cyclic,
      ),
    ).rejects.toBeInstanceOf(IpcContractError);
    expect(fixture.cancelProcessing).not.toHaveBeenCalled();
  });

  it("dispatches validated business requests only", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.cancelProcessing, trustedEvent, {
        jobId: 23,
      }),
    ).resolves.toEqual({ protocolVersion: 2, jobId: 23, state: "canceled" });
    expect(fixture.cancelProcessing).toHaveBeenCalledOnce();
    expect(fixture.cancelProcessing).toHaveBeenCalledWith(23);
    await expect(
      fixture.handlers.invoke(ipcChannels.importAudio, trustedEvent, {}),
    ).resolves.toEqual({ protocolVersion: 2, state: "canceled" });
    await expect(
      fixture.handlers.invoke(ipcChannels.importAudio, trustedEvent, {
        sourcePath: "/etc/passwd",
      }),
    ).rejects.toBeInstanceOf(IpcContractError);
  });

  it("wraps processing tasks in the versioned Main envelope consumed by preload", async () => {
    const fixture = handlers();
    const bridge = {
      invoke: async (channel: string, payload: unknown) =>
        await fixture.handlers.invoke(channel, trustedEvent, payload),
      on: vi.fn(),
      off: vi.fn(),
    };

    await expect(
      createDesktopApi(bridge).listProcessingTasks(),
    ).resolves.toEqual([]);
    await expect(
      fixture.handlers.invoke(ipcChannels.processingTasks, trustedEvent, {
        expectedProtocolVersion: 2,
      }),
    ).resolves.toEqual({ protocolVersion: 2, tasks: [] });
  });

  it("exposes only validated application snapshot and navigation commands", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.applicationSnapshot, trustedEvent, {
        expectedProtocolVersion: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ navigation: { section: "library" } }),
    );
    await expect(
      fixture.handlers.invoke(ipcChannels.applicationNavigate, trustedEvent, {
        section: "settings",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ navigation: { section: "settings" } }),
    );
    await expect(
      fixture.handlers.invoke(ipcChannels.applicationNavigate, trustedEvent, {
        section: "raw-filesystem",
      }),
    ).rejects.toBeInstanceOf(IpcContractError);
  });

  it("allows only the exact packaged renderer file URL", async () => {
    const workerHealth = vi.fn(async () => ({
      protocolVersion: 2 as const,
      protocol: "desktop-sherpa-worker-health/v1" as const,
      runtime: "sherpa-onnx" as const,
      workerSha256: "c".repeat(64),
    }));
    const packaged = createDesktopIpcHandlers({
      trust: {
        senderId: 1,
        frameId: 2,
        origins: new Set(),
        fileUrls: new Set(["file:///Voice2Text/renderer/index.html"]),
      },
      services: {
        getCompanionSnapshot: vi.fn(),
        setCompanionOptIn: vi.fn(),
        createCompanionPairingInvite: vi.fn(),
        revokeCompanionPeer: vi.fn(),
        cancelCompanionTransfer: vi.fn(),
        retryCompanionTransfer: vi.fn(),
        getAiSettings: vi.fn(),
        saveAiSettings: vi.fn(),
        replaceAiProviderSecret: vi.fn(),
        deleteAiProviderSecret: vi.fn(),
        prepareAudioAi: vi.fn(),
        getAudioAiSnapshot: vi.fn(async () => null),
        generateAudioAi: vi.fn(),
        retryAudioAi: vi.fn(),
        applicationSnapshot: () => applicationSnapshot(),
        navigate: (section) => ({
          ...applicationSnapshot(),
          navigation: { section },
        }),
        requestBootstrapAction: async () => applicationSnapshot(),
        workerHealth,
        cancelProcessing: vi.fn(),
        retryProcessing: vi.fn(),
        listProcessingTasks: vi.fn(async () => []),
        importAudio: vi.fn(async () => ({
          protocolVersion: 2 as const,
          state: "canceled" as const,
        })),
        preflightCapture: vi.fn(),
        startCapture: vi.fn(),
        controlCapture: vi.fn(),
        listCaptureRecoveries: vi.fn(async () => []),
        actOnCaptureRecovery: vi.fn(),
        getCaptionSnapshot: vi.fn(async () => null),
        retryFormalTranscript: vi.fn(),
        listAudios: vi.fn(async () => []),
        openAudio: vi.fn(async () => null),
        searchTranscript: vi.fn(async () => []),
        editAudioSegment: vi.fn(),
        undoAudioEdit: vi.fn(),
        redoAudioEdit: vi.fn(),
        renameAudioSpeaker: vi.fn(),
        mergeAudioSpeakers: vi.fn(),
        assignAudioSpeaker: vi.fn(),
        controlAudioPlayback: vi.fn(),
        exportAudio: vi.fn(),
      },
    });
    const payload = { expectedProtocolVersion: 2 };
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///Voice2Text/renderer/index.html",
        },
        payload,
      ),
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 2 }));
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///Voice2Text/renderer/index.html#/tasks",
        },
        payload,
      ),
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 2 }));
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///Voice2Text/renderer/index.html#/audio",
        },
        payload,
      ),
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 2 }));
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///%56oice2Text/renderer/index.html",
        },
        payload,
      ),
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 2 }));
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///Voice2Text/renderer/index.html?untrusted=1",
        },
        payload,
      ),
    ).rejects.toBeInstanceOf(IpcContractError);
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///Voice2Text/renderer/index.html#/unknown",
        },
        payload,
      ),
    ).rejects.toBeInstanceOf(IpcContractError);
    await expect(
      packaged.invoke(
        ipcChannels.workerHealth,
        {
          senderId: 1,
          frameId: 2,
          origin: "file:///tmp/attacker.html",
        },
        payload,
      ),
    ).rejects.toBeInstanceOf(IpcContractError);
    expect(workerHealth).toHaveBeenCalledTimes(4);
  });
});

function applicationSnapshot() {
  return {
    protocolVersion: 2 as const,
    revision: 1,
    navigation: { section: "library" as const },
    profile: { phase: "ready" as const },
    connectivity: "online" as const,
    capability: { processing: "available" as const },
    library: { phase: "empty" as const },
    reconciliation: [],
    capture: { phase: "idle" as const },
  };
}
