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
    protocolVersion: 1 as const,
    protocol: "desktop-sherpa-worker-health/v1" as const,
    runtime: "sherpa-onnx" as const,
    workerSha256: "b".repeat(64),
  }));
  const cancelProcessing = vi.fn(async (jobId: number) => ({
    protocolVersion: 1 as const,
    jobId,
    state: "canceled" as const,
  }));
  return {
    cancelProcessing,
    handlers: createDesktopIpcHandlers({
      trust: {
        senderId: trustedEvent.senderId,
        frameId: trustedEvent.frameId,
        origins: new Set([trustedEvent.origin]),
      },
      services: {
        applicationSnapshot: () => applicationSnapshot(),
        navigate: (section) => ({
          ...applicationSnapshot(),
          navigation: { section },
        }),
        requestBootstrapAction: async () => applicationSnapshot(),
        workerHealth,
        cancelProcessing,
        retryProcessing: vi.fn(async (jobId: number) => ({
          protocolVersion: 1 as const,
          jobId,
          state: "queued" as const,
        })),
        listProcessingTasks: vi.fn(async () => []),
        importMeeting: vi.fn(async () => ({
          protocolVersion: 1 as const,
          state: "canceled" as const,
        })),
        preflightCapture: vi.fn(),
        startCapture: vi.fn(),
        controlCapture: vi.fn(),
        listCaptureRecoveries: vi.fn(async () => []),
        actOnCaptureRecovery: vi.fn(),
        listMeetings: vi.fn(async () => []),
        openMeeting: vi.fn(async () => null),
        searchTranscript: vi.fn(async () => []),
        editMeetingSegment: vi.fn(),
        undoMeetingEdit: vi.fn(),
        redoMeetingEdit: vi.fn(),
        renameMeetingSpeaker: vi.fn(),
        mergeMeetingSpeakers: vi.fn(),
        assignMeetingSpeaker: vi.fn(),
        controlMeetingPlayback: vi.fn(),
        exportMeeting: vi.fn(),
      },
      maximumPayloadBytes: 1024,
    }),
    workerHealth,
  };
}

describe("Main IPC validation", () => {
  it("rejects raw capture paths before they reach Main services", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.captureStart, trustedEvent, {
        title: "会议",
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
          expectedProtocolVersion: 1,
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
    ).resolves.toEqual({ protocolVersion: 1, jobId: 23, state: "canceled" });
    expect(fixture.cancelProcessing).toHaveBeenCalledOnce();
    expect(fixture.cancelProcessing).toHaveBeenCalledWith(23);
    await expect(
      fixture.handlers.invoke(ipcChannels.importMeeting, trustedEvent, {}),
    ).resolves.toEqual({ protocolVersion: 1, state: "canceled" });
    await expect(
      fixture.handlers.invoke(ipcChannels.importMeeting, trustedEvent, {
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
        expectedProtocolVersion: 1,
      }),
    ).resolves.toEqual({ protocolVersion: 1, tasks: [] });
  });

  it("exposes only validated application snapshot and navigation commands", async () => {
    const fixture = handlers();
    await expect(
      fixture.handlers.invoke(ipcChannels.applicationSnapshot, trustedEvent, {
        expectedProtocolVersion: 1,
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
      protocolVersion: 1 as const,
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
        importMeeting: vi.fn(async () => ({
          protocolVersion: 1 as const,
          state: "canceled" as const,
        })),
        preflightCapture: vi.fn(),
        startCapture: vi.fn(),
        controlCapture: vi.fn(),
        listCaptureRecoveries: vi.fn(async () => []),
        actOnCaptureRecovery: vi.fn(),
        listMeetings: vi.fn(async () => []),
        openMeeting: vi.fn(async () => null),
        searchTranscript: vi.fn(async () => []),
        editMeetingSegment: vi.fn(),
        undoMeetingEdit: vi.fn(),
        redoMeetingEdit: vi.fn(),
        renameMeetingSpeaker: vi.fn(),
        mergeMeetingSpeakers: vi.fn(),
        assignMeetingSpeaker: vi.fn(),
        controlMeetingPlayback: vi.fn(),
        exportMeeting: vi.fn(),
      },
    });
    const payload = { expectedProtocolVersion: 1 };
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
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 1 }));
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
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 1 }));
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
    ).resolves.toEqual(expect.objectContaining({ protocolVersion: 1 }));
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
    expect(workerHealth).toHaveBeenCalledTimes(3);
  });
});

function applicationSnapshot() {
  return {
    protocolVersion: 1 as const,
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
