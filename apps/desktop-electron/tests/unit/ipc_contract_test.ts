import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cancelProcessingRequestSchema,
  desktopErrorSchema,
  desktopProtocolVersion,
  importAudioResponseSchema,
  ipcChannels,
  operationEventSchema,
  workerHealthRequestSchema,
} from "../../src/shared/contracts/index";
import { createDesktopApi } from "../../src/preload/api";

describe("shared IPC contracts", () => {
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
