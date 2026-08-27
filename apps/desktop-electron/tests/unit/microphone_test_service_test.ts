import { describe, expect, it, vi } from "vitest";

import {
  MicrophoneTestNativeError,
  type CaptureNativePort,
} from "../../src/main/domain/capture/capture_native_port";
import { MicrophoneTestService } from "../../src/main/domain/capture/microphone_test_service";
import type { MicrophoneTestSnapshot } from "../../src/shared/contracts";

describe("MicrophoneTestService", () => {
  it("keeps finish and owner cancel distinct and idempotent", async () => {
    const finishMicrophoneTest = vi.fn(async (testId: string) =>
      snapshot(testId, "finished", "detected"),
    );
    const cancelMicrophoneTest = vi.fn(async (testId: string) =>
      snapshot(testId, "cancelled"),
    );
    const native = microphonePort({
      finishMicrophoneTest,
      cancelMicrophoneTest,
    });
    const service = new MicrophoneTestService(native);
    const started = await service.start({ ownerId: 7 });
    const first = await service.finish({ ownerId: 7, testId: started.testId });
    const repeated = await service.finish({
      ownerId: 7,
      testId: started.testId,
    });
    expect(first.reason).toBe("detected");
    expect(repeated).toEqual(first);
    expect(finishMicrophoneTest).toHaveBeenCalledTimes(1);

    const ownerService = new MicrophoneTestService(native);
    await ownerService.start({ ownerId: 9 });
    await ownerService.stopForOwner(9);
    expect(cancelMicrophoneTest).toHaveBeenCalledTimes(1);
  });

  it("maps typed transport and live response failures without parsing text", async () => {
    const transportService = new MicrophoneTestService(
      microphonePort({
        microphoneTestSnapshot: vi.fn(async () => {
          throw new MicrophoneTestNativeError("transport");
        }),
      }),
    );
    const transportStarted = await transportService.start({ ownerId: 1 });
    await expect(
      transportService.snapshot({
        ownerId: 1,
        testId: transportStarted.testId,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "failed",
        reason: "native-helper-failed",
      }),
    );

    const responseService = new MicrophoneTestService(
      microphonePort({
        microphoneTestSnapshot: vi.fn(async () => {
          throw new MicrophoneTestNativeError("response");
        }),
      }),
    );
    const responseStarted = await responseService.start({ ownerId: 2 });
    await expect(
      responseService.snapshot({ ownerId: 2, testId: responseStarted.testId }),
    ).resolves.toEqual(
      expect.objectContaining({ state: "failed", reason: "snapshot-failed" }),
    );
  });
});

function microphonePort(
  overrides: Partial<CaptureNativePort> = {},
): CaptureNativePort {
  return {
    startMicrophoneTest: async (testId: string) => snapshot(testId, "running"),
    microphoneTestSnapshot: async (testId: string) =>
      snapshot(testId, "running"),
    finishMicrophoneTest: async (testId: string) =>
      snapshot(testId, "finished", "detected"),
    cancelMicrophoneTest: async (testId: string) =>
      snapshot(testId, "cancelled"),
    ...overrides,
  } as CaptureNativePort;
}

function snapshot(
  testId: string,
  state: MicrophoneTestSnapshot["state"],
  reason?: MicrophoneTestSnapshot["reason"],
): MicrophoneTestSnapshot {
  return {
    testId,
    state,
    ...(reason ? { reason } : {}),
    elapsedMs: 0,
    normalizedRMS: state === "running" ? 0.01 : 0,
    normalizedPeak: state === "running" ? 0.5 : 0,
    observedFrames: state === "running" ? 1_024 : 0,
    observedSound: state === "finished" && reason === "detected",
  };
}
