import { EventEmitter } from "node:events";

import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  createDesktopIpcRegistry,
  desktopIpcInvokeChannels,
} from "../../src/main/ipc/register_desktop_ipc";
import type { DesktopIpcServices } from "../../src/main/ipc/desktop_ipc";
import {
  ipcChannels,
  type FloatingCaptureSnapshot,
} from "../../src/shared/contracts";

describe("desktop IPC window registry", () => {
  it("registers process handlers once and authorizes each trusted window by capability", async () => {
    const ipc = new FakeIpcMain();
    const services = createServices();
    const registry = createDesktopIpcRegistry(services.value, ipc);
    const main = createWindow(41, 9, "http://localhost:5173");
    const floating = createWindow(42, 10, "http://localhost:5174");

    const unregisterMain = registry.registerWindow(main.window, {
      capability: "main",
      origins: new Set(["http://localhost:5173"]),
    });
    const unregisterFloating = registry.registerWindow(floating.window, {
      capability: "floating-capture",
      origins: new Set(["http://localhost:5174"]),
    });

    expect(ipc.handle).toHaveBeenCalledTimes(desktopIpcInvokeChannels.length);
    await expect(
      ipc.invoke(ipcChannels.workerHealth, main.event, {
        expectedProtocolVersion: 2,
      }),
    ).resolves.toMatchObject({ protocolVersion: 2 });
    await expect(
      ipc.invoke(ipcChannels.applicationActivityMarkRead, main.event, {
        activityId: "activity-1",
      }),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(
      ipc.invoke(ipcChannels.applicationActivityMarkAllRead, main.event, {}),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(
      ipc.invoke(ipcChannels.applicationBootstrapAction, main.event, {
        action: "recheck",
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect(services.requestBootstrapAction).toHaveBeenCalledWith("recheck");
    await expect(
      ipc.invoke(ipcChannels.aiProviderProfileCreate, main.event, {
        expectedRevision: 2,
        protocol: "openai-compatible",
        modelId: "gpt-compatible",
        endpoint: "https://ai.example.com/v1",
        secret: "sk-create-secret",
      }),
    ).resolves.toEqual(aiSettingsSnapshot());
    expect(services.createAiProviderProfile).toHaveBeenCalledWith({
      expectedRevision: 2,
      protocol: "openai-compatible",
      modelId: "gpt-compatible",
      endpoint: "https://ai.example.com/v1",
      secret: "sk-create-secret",
    });
    await expect(
      ipc.invoke(ipcChannels.aiProviderProfileSelect, main.event, {
        profileId: "profile-123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      ipc.invoke(ipcChannels.applicationActivityMarkRead, floating.event, {
        activityId: "activity-1",
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    await expect(
      ipc.invoke(ipcChannels.captureControl, floating.event, {
        action: "pause",
        sessionId: "session-capture-123456",
        idempotencyKey: "capture-pause-123456",
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    expect(services.controlCapture).not.toHaveBeenCalled();
    await expect(
      ipc.invoke(ipcChannels.floatingCaptureSnapshotGet, floating.event, {}),
    ).resolves.toEqual(
      expect.objectContaining({ phase: "recording", sessionId: "opaque-1" }),
    );
    await expect(
      ipc.invoke(ipcChannels.floatingCaptureControl, floating.event, {
        action: "pause",
        sessionId: "session-capture-123456",
        idempotencyKey: "floating-pause-123456",
      }),
    ).resolves.toEqual(expect.objectContaining({ phase: "recording" }));
    expect(services.controlFloatingCapture).toHaveBeenCalledOnce();
    await expect(
      ipc.invoke(ipcChannels.floatingCaptureWindowAction, floating.event, {
        action: "open-details",
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "opaque-1" }));
    expect(services.floatingCaptureWindowAction).toHaveBeenCalledWith(
      "open-details",
    );
    await expect(
      ipc.invoke(ipcChannels.floatingCaptureControl, main.event, {
        action: "pause",
        sessionId: "session-capture-123456",
        idempotencyKey: "floating-pause-main-123456",
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    await expect(
      ipc.invoke(ipcChannels.workerHealth, floating.event, {
        expectedProtocolVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });

    const unregistered = createWindow(43, 11, "http://localhost:5175");
    await expect(
      ipc.invoke(ipcChannels.workerHealth, unregistered.event, {
        expectedProtocolVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    const senderIdImpersonator = createWindow(41, 12, "http://localhost:5173");
    await expect(
      ipc.invoke(ipcChannels.workerHealth, senderIdImpersonator.event, {
        expectedProtocolVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });

    unregisterMain();
    expect(ipc.removeHandler).not.toHaveBeenCalled();
    await expect(
      ipc.invoke(ipcChannels.workerHealth, floating.event, {
        expectedProtocolVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });

    unregisterFloating();
    registry.dispose();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(
      desktopIpcInvokeChannels.length,
    );
  });

  it("fans events out by capability and removes only a destroyed window", () => {
    const ipc = new FakeIpcMain();
    const services = createServices();
    const registry = createDesktopIpcRegistry(services.value, ipc);
    const main = createWindow(51, 19, "http://localhost:5173");
    const floating = createWindow(52, 20, "http://localhost:5174");
    registry.registerWindow(main.window, {
      capability: "main",
      origins: new Set(["http://localhost:5173"]),
    });
    registry.registerWindow(floating.window, {
      capability: "floating-capture",
      origins: new Set(["http://localhost:5174"]),
    });

    services.emitApplicationSnapshot(applicationSnapshot(2));
    expect(main.send).toHaveBeenCalledWith(
      ipcChannels.applicationSnapshotEvent,
      applicationSnapshot(2),
    );
    expect(floating.send).not.toHaveBeenCalled();
    services.emitFloatingSnapshot();
    expect(floating.send).toHaveBeenCalledWith(
      ipcChannels.floatingCaptureSnapshotEvent,
      expect.objectContaining({ sessionId: "opaque-1" }),
    );

    main.destroy();
    services.emitApplicationSnapshot(applicationSnapshot(3));
    expect(main.send).toHaveBeenCalledTimes(1);
    expect(floating.send).toHaveBeenCalledTimes(1);
    expect(ipc.removeHandler).not.toHaveBeenCalled();

    registry.dispose();
    expect(services.unsubscribeApplicationSnapshot).toHaveBeenCalledOnce();
  });

  it("refuses duplicate sender registrations and releases the process owner on dispose", () => {
    const ipc = new FakeIpcMain();
    const services = createServices();
    const first = createDesktopIpcRegistry(services.value, ipc);
    const main = createWindow(61, 29, "http://localhost:5173");
    first.registerWindow(main.window, {
      capability: "main",
      origins: new Set(["http://localhost:5173"]),
    });

    expect(() =>
      first.registerWindow(main.window, {
        capability: "main",
        origins: new Set(["http://localhost:5173"]),
      }),
    ).toThrow(/already registered/i);
    expect(() => createDesktopIpcRegistry(services.value, ipc)).toThrow(
      /already registered/i,
    );

    first.dispose();
    const second = createDesktopIpcRegistry(services.value, ipc);
    second.dispose();
  });
});

class FakeIpcMain {
  readonly handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  >();
  readonly handle = vi.fn(
    (
      channel: string,
      handler: (
        event: IpcMainInvokeEvent,
        payload: unknown,
      ) => Promise<unknown>,
    ) => {
      if (this.handlers.has(channel)) throw new Error("handler already exists");
      this.handlers.set(channel, handler);
    },
  );
  readonly removeHandler = vi.fn((channel: string) => {
    this.handlers.delete(channel);
  });

  async invoke(
    channel: string,
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return await handler(event, payload);
  }
}

function createWindow(senderId: number, frameId: number, url: string) {
  const windowEvents = new EventEmitter();
  const webContentsEvents = new EventEmitter();
  const send = vi.fn();
  let destroyed = false;
  const mainFrame = {
    routingId: frameId,
    processId: 7,
    parent: null,
    url,
  };
  const webContents = Object.assign(webContentsEvents, {
    id: senderId,
    mainFrame,
    getURL: () => url,
    send,
  }) as unknown as WebContents;
  const window = Object.assign(windowEvents, {
    webContents,
    isDestroyed: () => destroyed,
  }) as unknown as BrowserWindow;
  const event = {
    sender: webContents,
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  return {
    destroy() {
      destroyed = true;
      windowEvents.emit("closed");
      webContentsEvents.emit("destroyed");
    },
    event,
    send,
    window,
  };
}

function createServices() {
  let applicationListener:
    ((snapshot: ReturnType<typeof applicationSnapshot>) => void) | undefined;
  const unsubscribeApplicationSnapshot = vi.fn();
  let floatingListener:
    ((snapshot: ReturnType<typeof floatingSnapshot>) => void) | undefined;
  const controlFloatingCapture = vi.fn(async () => floatingSnapshot());
  const floatingCaptureWindowAction = vi.fn(async () => floatingSnapshot());
  const createAiProviderProfile = vi.fn(async () => aiSettingsSnapshot());
  const requestBootstrapAction = vi.fn(async () => applicationSnapshot(1));
  const defined: Partial<DesktopIpcServices> = {
    applicationSnapshot: () => applicationSnapshot(1),
    requestBootstrapAction,
    markActivityRead: vi.fn(() => applicationSnapshot(1)),
    markAllActivityRead: vi.fn(() => applicationSnapshot(1)),
    controlCapture: vi.fn(async () => ({
      state: "paused" as const,
      sessionId: "session-capture-123456",
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
    })),
    workerHealth: vi.fn(async () => ({
      protocolVersion: 2 as const,
      protocol: "desktop-sherpa-worker-health/v1" as const,
      runtime: "sherpa-onnx" as const,
      workerSha256: "b".repeat(64),
    })),
    onApplicationSnapshot: (listener) => {
      applicationListener = listener;
      return unsubscribeApplicationSnapshot;
    },
    floatingCaptureSnapshot: () => floatingSnapshot(),
    controlFloatingCapture,
    floatingCaptureWindowAction,
    createAiProviderProfile,
    onFloatingCaptureSnapshot: (listener) => {
      floatingListener = listener;
      return vi.fn();
    },
  };
  const value = new Proxy(defined, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (typeof property === "string" && property.startsWith("on")) {
        return undefined;
      }
      return vi.fn(async () => undefined);
    },
  }) as DesktopIpcServices;
  return {
    controlCapture: defined.controlCapture,
    controlFloatingCapture,
    createAiProviderProfile,
    floatingCaptureWindowAction,
    requestBootstrapAction,
    emitApplicationSnapshot(snapshot: ReturnType<typeof applicationSnapshot>) {
      applicationListener?.(snapshot);
    },
    emitFloatingSnapshot() {
      floatingListener?.(floatingSnapshot());
    },
    unsubscribeApplicationSnapshot,
    value,
  };
}

function floatingSnapshot(): FloatingCaptureSnapshot {
  return {
    revision: 1,
    sessionId: "opaque-1",
    phase: "recording" as const,
    elapsedMs: 1_000,
    allowedActions: ["pause", "stop"],
    attention: false,
  };
}

function aiSettingsSnapshot() {
  return {
    revision: 3,
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
      fileVaultState: "unknown" as const,
      applicationLayerEncryption: "not-claimed" as const,
    },
  };
}

function applicationSnapshot(revision: number) {
  return {
    protocolVersion: 2 as const,
    revision,
    navigation: { section: "library" as const },
    profile: { phase: "ready" as const, legacyDatabaseArchived: false },
    connectivity: "online" as const,
    capability: { processing: "available" as const },
    library: { phase: "empty" as const },
    reconciliation: [],
    capture: { phase: "idle" as const },
  };
}
