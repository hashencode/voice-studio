import { describe, expect, it, vi } from "vitest";

import { MicrophoneTestNativeError } from "../../src/main/domain/capture/capture_native_port";
import {
  type MicrophoneTestNativePort,
  MicrophoneTestService,
} from "../../src/main/domain/capture/microphone_test_service";
import type { MicrophoneTestSnapshot } from "../../src/shared/contracts";

describe("MicrophoneTestService", () => {
  it("keeps recoverable running snapshots active and preserves terminal diagnostics", async () => {
    const microphoneTestSnapshot = vi
      .fn<() => Promise<MicrophoneTestSnapshot>>()
      .mockResolvedValueOnce({
        ...snapshot("mic-test-placeholder-123456", "running"),
        elapsedMs: 250,
        observedFrames: 2_048,
      })
      .mockResolvedValueOnce({
        ...snapshot(
          "mic-test-placeholder-123456",
          "failed",
          "device-open-failed",
        ),
        diagnostic: "recovery_restart_failed",
      });
    const service = new MicrophoneTestService(
      microphonePort({
        microphoneTestSnapshot: async (testId) => {
          const next = await microphoneTestSnapshot();
          return { ...next, testId };
        },
      }),
    );
    const started = await service.start({ ownerId: 11 });

    const recovering = await service.snapshot({
      ownerId: 11,
      testId: started.testId,
    });
    expect(recovering).toEqual(
      expect.objectContaining({ state: "running", observedFrames: 2_048 }),
    );
    const failed = await service.snapshot({
      ownerId: 11,
      testId: started.testId,
    });
    expect(failed).toEqual(
      expect.objectContaining({
        state: "failed",
        reason: "device-open-failed",
        diagnostic: "recovery_restart_failed",
      }),
    );
    await expect(
      service.snapshot({ ownerId: 11, testId: started.testId }),
    ).resolves.toEqual(failed);
    expect(microphoneTestSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not let a late recovery snapshot reacquire ownership after cancel", async () => {
    const pendingRecovery = deferred<MicrophoneTestSnapshot>();
    const cancelMicrophoneTest = vi.fn(async (testId: string) =>
      snapshot(testId, "cancelled"),
    );
    const native = microphonePort({
      microphoneTestSnapshot: vi.fn(() => pendingRecovery.promise),
      cancelMicrophoneTest,
    });
    const service = new MicrophoneTestService(native);
    const started = await service.start({ ownerId: 12 });
    const recovery = service.snapshot({ ownerId: 12, testId: started.testId });

    const cancelled = await service.cancel({
      ownerId: 12,
      testId: started.testId,
    });
    pendingRecovery.resolve({
      ...snapshot(started.testId, "running"),
      elapsedMs: 500,
      observedFrames: 4_096,
    });

    await expect(recovery).resolves.toEqual(cancelled);
    await expect(
      service.snapshot({ ownerId: 12, testId: started.testId }),
    ).resolves.toEqual(cancelled);
    await expect(service.start({ ownerId: 13 })).resolves.toEqual(
      expect.objectContaining({ state: "running" }),
    );
    expect(cancelMicrophoneTest).toHaveBeenCalledOnce();
  });

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function microphonePort(
  overrides: Partial<MicrophoneTestNativePort> = {},
): MicrophoneTestNativePort {
  return {
    startMicrophoneTest: async (testId: string) => snapshot(testId, "running"),
    microphoneTestSnapshot: async (testId: string) =>
      snapshot(testId, "running"),
    finishMicrophoneTest: async (testId: string) =>
      snapshot(testId, "finished", "detected"),
    cancelMicrophoneTest: async (testId: string) =>
      snapshot(testId, "cancelled"),
    ...overrides,
  };
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
