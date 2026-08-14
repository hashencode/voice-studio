import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../src/shared/contracts/index";
import {
  IpcContractError,
  createDesktopIpcHandlers,
} from "../../src/main/ipc/desktop_ipc";

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
      services: { workerHealth, cancelProcessing },
      maximumPayloadBytes: 1024,
    }),
    workerHealth,
  };
}

describe("Main IPC validation", () => {
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
        workerHealth,
        cancelProcessing: vi.fn(),
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
          origin: "file:///tmp/attacker.html",
        },
        payload,
      ),
    ).rejects.toBeInstanceOf(IpcContractError);
    expect(workerHealth).toHaveBeenCalledOnce();
  });
});
