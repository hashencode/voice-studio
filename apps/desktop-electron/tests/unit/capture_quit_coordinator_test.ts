import { describe, expect, it, vi } from "vitest";

import {
  CaptureQuitCoordinator,
  type CaptureQuitCoordinatorOptions,
  type CaptureQuitCoordinatorPorts,
  type QuitDecision,
  type QuitDecisionKind,
} from "../../src/main/domain/capture/capture_quit_coordinator";
import { captureSnapshotSchema } from "../../src/shared/contracts";

describe("CaptureQuitCoordinator", () => {
  it("cancels the initial decision without stopping or tearing down", async () => {
    const harness = createHarness();
    harness.decisions.push("continue-recording");

    await expect(harness.coordinator.requestInteractive()).resolves.toBe(
      "cancelled",
    );
    expect(harness.ports.stopAndReconcile).not.toHaveBeenCalled();
    expect(harness.ports.teardown).not.toHaveBeenCalled();
    expect(harness.ports.activate).toHaveBeenCalledOnce();
    expect(harness.ports.showDecision).toHaveBeenCalledWith(
      "initial",
      undefined,
    );
  });

  it("joins repeated quit events and commits once", async () => {
    const harness = createHarness();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({
        state: "completed",
        recordingSha256: "a".repeat(64),
      }),
      capability: "recovered-terminal",
    });

    const first = harness.coordinator.requestInteractive();
    const second = harness.coordinator.requestInteractive();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "committed",
      "committed",
    ]);
    expect(harness.ports.showDecision).toHaveBeenCalledOnce();
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    expect(harness.ports.teardown).toHaveBeenCalledOnce();
    expect(harness.ports.quit).toHaveBeenCalledOnce();
  });

  it("automatically preserves a live failure without retrying the stop", async () => {
    const harness = createHarness();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({ state: "recording" }),
      capability: "live-stoppable",
    });

    await expect(harness.coordinator.requestInteractive()).resolves.toBe(
      "recoverable-exit",
    );
    expect(harness.kinds).toEqual(["initial"]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    expect(harness.ports.teardown).toHaveBeenCalledWith("recovery-exit");
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it.each([["recovered-terminal"], ["unknown"]] as const)(
    "automatically exits after one bounded reconciliation for %s authority",
    async (capability) => {
      const harness = createHarness();
      harness.decisions.push("stop-and-exit");
      harness.ports.stopAndReconcile.mockResolvedValue({
        snapshot: snapshot({
          state: capability === "unknown" ? "failed" : "recoverable",
        }),
        capability,
      });

      await expect(harness.coordinator.requestInteractive()).resolves.toBe(
        "recoverable-exit",
      );
      expect(harness.kinds).toEqual(["initial"]);
      expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
      expect(harness.ports.teardown).toHaveBeenCalledOnce();
      expect(harness.ports.exit).toHaveBeenCalledOnce();
    },
  );

  it("keeps waiting for the original stop without presenting a recovery decision", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);
    harness.ports.showDecision.mockImplementation(async (kind) => {
      harness.kinds.push(kind);
      return "stop-and-exit";
    });

    const result = harness.coordinator.requestInteractive();
    await Promise.resolve();
    expect(harness.kinds).toEqual(["initial"]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    expect(harness.ports.abortCapture).not.toHaveBeenCalled();

    stop.resolve({
      snapshot: snapshot({
        state: "completed",
        recordingSha256: "c".repeat(64),
      }),
      capability: "recovered-terminal",
    });
    await expect(result).resolves.toBe("committed");
    expect(harness.ports.quit).toHaveBeenCalledOnce();
  });

  it("joins repeated quit requests during normal teardown", async () => {
    const harness = createHarness();
    const teardown = deferred<void>();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({
        state: "completed",
        recordingSha256: "f".repeat(64),
      }),
      capability: "recovered-terminal",
    });
    harness.ports.teardown.mockReturnValue(teardown.promise);

    const first = harness.coordinator.requestInteractive();
    await vi.waitFor(() =>
      expect(harness.coordinator.phase).toBe("tearing-down"),
    );
    const second = harness.coordinator.requestNonInteractive();
    expect(second).toBe(first);
    teardown.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "committed",
      "committed",
    ]);
    expect(harness.ports.teardown).toHaveBeenCalledOnce();
    expect(harness.ports.quit).toHaveBeenCalledOnce();
  });

  it("waits for one recovery teardown and joins repeated quit requests", async () => {
    const harness = createHarness();
    const teardown = deferred<void>();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({ state: "recoverable" }),
      capability: "recovered-terminal",
    });
    harness.ports.teardown.mockReturnValue(teardown.promise);

    const first = harness.coordinator.requestInteractive();
    await vi.waitFor(() =>
      expect(harness.coordinator.phase).toBe("tearing-down"),
    );
    const second = harness.coordinator.requestNonInteractive();
    expect(second).toBe(first);
    expect(harness.ports.exit).not.toHaveBeenCalled();

    teardown.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "recoverable-exit",
      "recoverable-exit",
    ]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    expect(harness.ports.teardown).toHaveBeenCalledOnce();
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it("uses one final exit when normal teardown rejects", async () => {
    const harness = createHarness();
    harness.ports.currentCapture.mockReturnValue(null);
    harness.ports.teardown.mockRejectedValue(new Error("teardown failed"));

    const first = harness.coordinator.requestInteractive();
    const second = harness.coordinator.requestNonInteractive();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "committed",
      "committed",
    ]);
    expect(harness.ports.quit).not.toHaveBeenCalled();
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it("bounds recovery teardown before issuing the single final exit", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ recoveryExitDeadlineMs: 5_000 });
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({ state: "failed" }),
      capability: "unknown",
    });
    harness.ports.teardown.mockReturnValue(new Promise(() => undefined));
    try {
      const result = harness.coordinator.requestInteractive();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.ports.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("recoverable-exit");
      expect(harness.ports.teardown).toHaveBeenCalledOnce();
      expect(harness.ports.exit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(options: CaptureQuitCoordinatorOptions = {}) {
  const decisions: string[] = [];
  const kinds: QuitDecisionKind[] = [];
  const ports = {
    currentCapture: vi.fn<CaptureQuitCoordinatorPorts["currentCapture"]>(() =>
      snapshot({ state: "recording" }),
    ),
    activate: vi.fn(),
    dialogParent: vi.fn(() => undefined),
    showDecision: vi.fn(async (kind: QuitDecisionKind) => {
      kinds.push(kind);
      return decisions.shift() as QuitDecision;
    }),
    stopAndReconcile: vi.fn(),
    returnToCapture: vi.fn(),
    suppressCapturePublications: vi.fn(),
    abortCapture: vi.fn(),
    teardown: vi.fn<CaptureQuitCoordinatorPorts["teardown"]>(
      async () => undefined,
    ),
    quit: vi.fn(),
    exit: vi.fn(),
  } satisfies CaptureQuitCoordinatorPorts;
  return {
    coordinator: new CaptureQuitCoordinator(ports, options),
    decisions,
    kinds,
    ports,
  };
}

function snapshot(overrides: Record<string, unknown>) {
  return captureSnapshotSchema.parse({
    sessionId: "session-quit-1234567",
    state: "recording",
    captureMode: "dual_track",
    captureTimelineMs: 1,
    systemAudioHealthy: true,
    microphoneHealthy: true,
    partialCapture: false,
    finalizedChunkCount: 0,
    eventCount: 0,
    gapCount: 0,
    interruptionReason: null,
    recordingSha256: null,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
