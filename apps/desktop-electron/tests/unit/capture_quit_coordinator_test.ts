import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CaptureQuitCoordinator,
  type CaptureQuitCoordinatorPorts,
  type QuitDecision,
  type QuitDecisionKind,
} from "../../src/main/domain/capture/capture_quit_coordinator";
import { captureSnapshotSchema } from "../../src/shared/contracts";

describe("CaptureQuitCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());

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

  it("retries a live failure and commits after a terminal result", async () => {
    const harness = createHarness();
    harness.decisions.push("stop-and-exit", "retry-stop");
    harness.ports.stopAndReconcile
      .mockResolvedValueOnce({
        snapshot: snapshot({ state: "recording" }),
        capability: "live-stoppable",
      })
      .mockResolvedValueOnce({
        snapshot: snapshot({
          state: "completed",
          recordingSha256: "b".repeat(64),
        }),
        capability: "recovered-terminal",
      });

    await expect(harness.coordinator.requestInteractive()).resolves.toBe(
      "committed",
    );
    expect(harness.kinds).toEqual(["initial", "live-failure"]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledTimes(2);
  });

  it("returns to capture after a live failure", async () => {
    const harness = createHarness();
    harness.decisions.push("stop-and-exit", "return-to-app");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({ state: "recording" }),
      capability: "live-stoppable",
    });

    await expect(harness.coordinator.requestInteractive()).resolves.toBe(
      "cancelled",
    );
    expect(harness.ports.showSafeReturn).toHaveBeenCalledWith("capture");
    expect(harness.ports.teardown).not.toHaveBeenCalled();
  });

  it("preserves recovery after a live failure", async () => {
    const harness = createHarness();
    harness.decisions.push("stop-and-exit", "preserve-and-exit");
    harness.ports.stopAndReconcile.mockResolvedValue({
      snapshot: snapshot({ state: "recording" }),
      capability: "live-stoppable",
    });

    await expect(harness.coordinator.requestInteractive()).resolves.toBe(
      "recoverable-exit",
    );
    expect(harness.ports.teardown).toHaveBeenCalledWith("recovery-exit");
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it.each([
    ["recovered-terminal", "recovered-failure"],
    ["unknown", "unknown-failure"],
  ] as const)(
    "does not offer retry for %s authority",
    async (capability, expectedKind) => {
      const harness = createHarness();
      harness.decisions.push("stop-and-exit", "return-safe-view");
      harness.ports.stopAndReconcile.mockResolvedValue({
        snapshot: snapshot({
          state: capability === "unknown" ? "failed" : "recoverable",
        }),
        capability,
      });

      await expect(harness.coordinator.requestInteractive()).resolves.toBe(
        "cancelled",
      );
      expect(harness.kinds).toEqual(["initial", expectedKind]);
      expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    },
  );

  it("shows one unresolved decision, keeps the original stop, and accepts late success", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    harness.decisions.push("stop-and-exit");
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);
    const unresolved = deferred<"continue-waiting" | "preserve-and-exit">();
    harness.ports.showDecision.mockImplementation(async (kind) => {
      harness.kinds.push(kind);
      return kind === "initial" ? "stop-and-exit" : await unresolved.promise;
    });

    const result = harness.coordinator.requestInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.kinds).toEqual(["initial", "unresolved"]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();

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

  it("keeps preserve-and-exit available after continuing to wait", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    harness.decisions.push(
      "stop-and-exit",
      "continue-waiting",
      "preserve-and-exit",
    );
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);

    const result = harness.coordinator.requestInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.kinds).toEqual(["initial", "unresolved", "unresolved"]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe("recoverable-exit");
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it("waits for the unresolved dialog to close before showing a late failure", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    const unresolved = deferred<"continue-waiting" | "preserve-and-exit">();
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);
    harness.ports.showDecision.mockImplementation(async (kind) => {
      harness.kinds.push(kind);
      if (kind === "initial") return "stop-and-exit";
      if (kind === "unresolved") return await unresolved.promise;
      return "return-to-app";
    });

    const result = harness.coordinator.requestInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    stop.resolve({
      snapshot: snapshot({ state: "recording" }),
      capability: "live-stoppable",
    });
    await Promise.resolve();
    expect(harness.kinds).toEqual(["initial", "unresolved"]);

    unresolved.resolve("continue-waiting");
    await expect(result).resolves.toBe("cancelled");
    expect(harness.kinds).toEqual(["initial", "unresolved", "live-failure"]);
  });

  it("joins repeated quit requests while stopping, choosing, and recovery-exiting", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    const unresolved = deferred<"continue-waiting" | "preserve-and-exit">();
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);
    harness.ports.teardown.mockReturnValue(new Promise(() => undefined));
    harness.ports.showDecision.mockImplementation(async (kind) => {
      harness.kinds.push(kind);
      return kind === "initial" ? "stop-and-exit" : await unresolved.promise;
    });

    const first = harness.coordinator.requestInteractive();
    const whileStopping = harness.coordinator.requestInteractive();
    expect(whileStopping).toBe(first);
    await vi.advanceTimersByTimeAsync(15_000);
    const whileChoosing = harness.coordinator.requestNonInteractive();
    expect(whileChoosing).toBe(first);

    unresolved.resolve("preserve-and-exit");
    await Promise.resolve();
    const whileRecoveryExiting = harness.coordinator.requestInteractive();
    expect(whileRecoveryExiting).toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(
      Promise.all([first, whileStopping, whileChoosing, whileRecoveryExiting]),
    ).resolves.toEqual([
      "recoverable-exit",
      "recoverable-exit",
      "recoverable-exit",
      "recoverable-exit",
    ]);
    expect(harness.ports.stopAndReconcile).toHaveBeenCalledOnce();
    expect(harness.ports.teardown).toHaveBeenCalledOnce();
    expect(harness.ports.exit).toHaveBeenCalledOnce();
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

  it("invalidates a late result after recovery exit and enforces the absolute deadline", async () => {
    const harness = createHarness();
    const stop =
      deferred<
        Awaited<ReturnType<CaptureQuitCoordinatorPorts["stopAndReconcile"]>>
      >();
    harness.decisions.push("stop-and-exit", "preserve-and-exit");
    harness.ports.stopAndReconcile.mockReturnValue(stop.promise);
    harness.ports.teardown.mockReturnValue(new Promise(() => undefined));

    const result = harness.coordinator.requestInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.ports.suppressCapturePublications).toHaveBeenCalledOnce();
    expect(harness.ports.abortCapture).toHaveBeenCalledOnce();
    expect(harness.ports.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.ports.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("recoverable-exit");
    expect(harness.ports.exit).toHaveBeenCalledOnce();

    stop.resolve({
      snapshot: snapshot({
        state: "completed",
        recordingSha256: "d".repeat(64),
      }),
      capability: "recovered-terminal",
    });
    await Promise.resolve();
    expect(harness.ports.quit).not.toHaveBeenCalled();
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it("uses a bounded non-interactive stop before preserving recovery", async () => {
    const harness = createHarness();
    harness.ports.stopAndReconcile.mockReturnValue(
      new Promise(() => undefined),
    );
    harness.ports.teardown.mockResolvedValue(undefined);

    const result = harness.coordinator.requestNonInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe("recoverable-exit");
    expect(harness.ports.showDecision).not.toHaveBeenCalled();
    expect(harness.ports.abortCapture).toHaveBeenCalledOnce();
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });

  it("still exits when abort throws synchronously", async () => {
    const harness = createHarness();
    harness.ports.stopAndReconcile.mockReturnValue(
      new Promise(() => undefined),
    );
    harness.ports.abortCapture.mockImplementation(() => {
      throw new Error("abort failed");
    });

    const result = harness.coordinator.requestNonInteractive();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe("recoverable-exit");
    expect(harness.ports.teardown).toHaveBeenCalledWith("recovery-exit");
    expect(harness.ports.exit).toHaveBeenCalledOnce();
  });
});

function createHarness() {
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
    publishCapture: vi.fn(),
    showSafeReturn: vi.fn(),
    suppressCapturePublications: vi.fn(),
    abortCapture: vi.fn(),
    teardown: vi.fn<CaptureQuitCoordinatorPorts["teardown"]>(
      async () => undefined,
    ),
    quit: vi.fn(),
    exit: vi.fn(),
  } satisfies CaptureQuitCoordinatorPorts;
  return {
    coordinator: new CaptureQuitCoordinator(ports, {
      stopWatchdogMs: 15_000,
      recoveryExitDeadlineMs: 5_000,
    }),
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
