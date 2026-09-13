import { describe, expect, it, vi } from "vitest";

import {
  FloatingCaptureWindowController,
  type FloatingCaptureControllerPorts,
  type FloatingCaptureWindowPort,
} from "../../src/main/features/capture/floating_capture_window_controller";
import type { FloatingCaptureSnapshot } from "../../src/shared/contracts";

describe("FloatingCaptureWindowController", () => {
  it("initializes its preference and listeners before the first reconcile", () => {
    const harness = createHarness({ enabled: true });

    harness.controller.initialize();

    expect(harness.events.slice(0, 4)).toEqual([
      "read-preference",
      "subscribe-snapshot",
      "subscribe-displays",
      "create-window",
    ]);
    expect(harness.events).toContain("create-window");
    expect(harness.window.setPosition).toHaveBeenCalledWith(1664, 56, false);
    expect(harness.window.showInactive).toHaveBeenCalledOnce();
  });

  it("keeps the window absent or hidden when presentation is not eligible", async () => {
    const harness = createHarness({ enabled: false });
    harness.controller.initialize();
    expect(harness.ports.createWindow).not.toHaveBeenCalled();

    await harness.controller.setPreference(true);
    harness.prominent = true;
    harness.emitEnvironment();
    expect(harness.window.hide).toHaveBeenCalledOnce();

    harness.prominent = false;
    harness.snapshot = snapshot({ phase: "idle", sessionId: null });
    harness.emitSnapshot();
    expect(harness.window.showInactive).toHaveBeenCalledOnce();
    expect(harness.window.hide).toHaveBeenCalledOnce();
    expect(harness.window.isVisible()).toBe(false);
  });

  it("deduplicates unchanged publications and repositions only when forced", () => {
    const harness = createHarness({ enabled: true });
    const listener = vi.fn();
    harness.controller.onSnapshot(listener);
    harness.controller.initialize();
    expect(listener).toHaveBeenCalledOnce();

    harness.emitSnapshot();
    expect(listener).toHaveBeenCalledOnce();
    expect(harness.window.setPosition).toHaveBeenCalledOnce();

    harness.emitDisplayChange();
    expect(harness.window.setPosition).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("suppresses a close for only the current session", () => {
    const harness = createHarness({ enabled: true });
    harness.controller.initialize();
    const close = { preventDefault: vi.fn() };

    harness.window.emitClose(close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(harness.window.hide).toHaveBeenCalledOnce();

    harness.emitEnvironment();
    expect(harness.window.showInactive).toHaveBeenCalledOnce();

    harness.snapshot = snapshot({ sessionId: "session-2", revision: 2 });
    harness.emitSnapshot();
    expect(harness.window.showInactive).toHaveBeenCalledTimes(2);
  });

  it("latches a load failure to its session and retries for the next session", async () => {
    const firstLoad = deferred<void>();
    const harness = createHarness({ enabled: true, loads: [firstLoad] });
    harness.controller.initialize();

    firstLoad.reject(new Error("load failed"));
    await firstLoad.promise.catch(() => undefined);
    await Promise.resolve();
    expect(harness.ports.reportLoadFailure).toHaveBeenCalledOnce();
    expect(harness.window.destroy).toHaveBeenCalledOnce();

    harness.emitEnvironment();
    expect(harness.ports.createWindow).toHaveBeenCalledOnce();

    harness.snapshot = snapshot({ sessionId: "session-2", revision: 2 });
    harness.emitSnapshot();
    expect(harness.ports.createWindow).toHaveBeenCalledTimes(2);
  });

  it("replaces its failed window without suppressing a newer session", async () => {
    const firstLoad = deferred<void>();
    const harness = createHarness({ enabled: true, loads: [firstLoad] });
    harness.controller.initialize();
    harness.snapshot = snapshot({ sessionId: "session-2", revision: 2 });
    harness.emitSnapshot();

    firstLoad.reject(new Error("late failure"));
    await firstLoad.promise.catch(() => undefined);
    await Promise.resolve();
    expect(harness.ports.reportLoadFailure).toHaveBeenCalledOnce();
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(harness.ports.createWindow).toHaveBeenCalledTimes(2);
    expect(harness.windows[1]!.showInactive).toHaveBeenCalledOnce();
  });

  it("ignores a load rejection from an already-retired window", async () => {
    const firstLoad = deferred<void>();
    const harness = createHarness({ enabled: true, loads: [firstLoad] });
    harness.controller.initialize();
    const firstWindow = harness.window;
    firstWindow.emitClosed();
    harness.emitEnvironment();
    const replacement = harness.windows[1]!;

    firstLoad.reject(new Error("retired window failed late"));
    await firstLoad.promise.catch(() => undefined);
    await Promise.resolve();

    expect(harness.ports.reportLoadFailure).not.toHaveBeenCalled();
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(replacement.showInactive).toHaveBeenCalledOnce();
  });

  it("serializes preference writes and changes memory only after durable success", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const harness = createHarness({ enabled: false });
    harness.ports.writePreference
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    harness.controller.initialize();

    const enabling = harness.controller.setPreference(true);
    const disabling = harness.controller.setPreference(false);
    await Promise.resolve();
    expect(harness.ports.writePreference).toHaveBeenCalledTimes(1);
    expect(harness.controller.getPreference()).toEqual({ enabled: false });

    first.resolve();
    await enabling;
    expect(harness.controller.getPreference()).toEqual({ enabled: true });
    await vi.waitFor(() =>
      expect(harness.ports.writePreference).toHaveBeenCalledTimes(2),
    );

    second.reject(new Error("disk full"));
    await expect(disabling).rejects.toThrow("disk full");
    expect(harness.controller.getPreference()).toEqual({ enabled: true });

    await expect(harness.controller.setPreference(false)).resolves.toEqual({
      enabled: false,
    });
    expect(harness.controller.getPreference()).toEqual({ enabled: false });
  });

  it("handles window actions without taking capture-control authority", async () => {
    const harness = createHarness({ enabled: true });
    harness.controller.initialize();

    await expect(
      harness.controller.handleWindowAction("hide"),
    ).resolves.toEqual(harness.snapshot);
    expect(harness.window.hide).toHaveBeenCalledOnce();

    await harness.controller.handleWindowAction("open-details");
    expect(harness.ports.openCaptureDetails).toHaveBeenCalledOnce();

    await harness.controller.handleWindowAction("turn-off");
    expect(harness.controller.getPreference()).toEqual({ enabled: false });
    expect(harness.ports.writePreference).toHaveBeenCalledWith(false);
  });

  it("rolls back a failed IPC registration and can retry creation", () => {
    const harness = createHarness({ enabled: true });
    harness.ports.registerWindow.mockImplementationOnce(() => {
      throw new Error("registration failed");
    });

    expect(() => harness.controller.initialize()).toThrow(
      "registration failed",
    );
    expect(harness.window.destroy).toHaveBeenCalledOnce();

    harness.emitEnvironment();
    expect(harness.ports.createWindow).toHaveBeenCalledTimes(2);
    expect(harness.windows[1]!.showInactive).toHaveBeenCalledOnce();
  });

  it("treats a destroyed window reference as absent and recreates it", () => {
    const harness = createHarness({ enabled: true });
    const firstCleanup = vi.fn();
    harness.ports.registerWindow.mockReturnValueOnce(firstCleanup);
    harness.controller.initialize();

    harness.window.destroy();
    harness.emitEnvironment();

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(harness.ports.createWindow).toHaveBeenCalledTimes(2);
    expect(harness.windows[1]!.showInactive).toHaveBeenCalledOnce();
  });

  it("rebinds IPC with at most one live registration", () => {
    const harness = createHarness({ enabled: true });
    const cleanups = [vi.fn(), vi.fn()];
    harness.ports.registerWindow
      .mockReturnValueOnce(cleanups[0]!)
      .mockReturnValueOnce(cleanups[1]!);
    harness.controller.initialize();

    harness.controller.rebindIpc();
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(harness.ports.registerWindow).toHaveBeenCalledTimes(2);

    harness.window.emitClosed();
    expect(cleanups[1]).toHaveBeenCalledOnce();
  });

  it("fences actions before draining preference work and disposes once later", async () => {
    const write = deferred<void>();
    const harness = createHarness({ enabled: true });
    harness.ports.writePreference.mockReturnValue(write.promise);
    harness.controller.initialize();
    const accepted = harness.controller.setPreference(false);

    const fenced = harness.controller.beginTeardown();
    await expect(harness.controller.setPreference(true)).rejects.toThrow(
      "teardown",
    );
    await expect(harness.controller.handleWindowAction("hide")).rejects.toThrow(
      "teardown",
    );
    expect(harness.window.destroy).not.toHaveBeenCalled();

    write.resolve();
    await accepted;
    await fenced;
    expect(harness.window.destroy).not.toHaveBeenCalled();

    await Promise.all([
      harness.controller.completeTeardown(),
      harness.controller.completeTeardown(),
    ]);
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(harness.unsubscribeSnapshot).toHaveBeenCalledOnce();
    expect(harness.unsubscribeDisplays).toHaveBeenCalledOnce();

    harness.emitSnapshot();
    harness.emitDisplayChange();
    expect(harness.ports.createWindow).toHaveBeenCalledOnce();
  });
});

function createHarness({
  enabled,
  loads = [],
}: {
  enabled: boolean;
  loads?: Array<ReturnType<typeof deferred<void>>>;
}) {
  const events: string[] = [];
  const windows: FakeWindow[] = [];
  let snapshotListener: ((value: FloatingCaptureSnapshot) => void) | undefined;
  let displayListener: (() => void) | undefined;
  const unsubscribeSnapshot = vi.fn();
  const unsubscribeDisplays = vi.fn();
  const state = {
    enabled,
    prominent: false,
    snapshot: snapshot(),
  };
  const ports = {
    currentSnapshot: () => state.snapshot,
    mainIsProminent: () => state.prominent,
    createWindow: vi.fn(() => {
      events.push("create-window");
      const window = new FakeWindow();
      windows.push(window);
      return {
        window,
        load: loads.shift()?.promise ?? Promise.resolve(),
        registrationTarget: window,
      };
    }),
    registerWindow: vi.fn(() => vi.fn()),
    readPreference: vi.fn(() => {
      events.push("read-preference");
      return state.enabled;
    }),
    writePreference: vi.fn(async (value) => {
      state.enabled = value;
    }),
    cursorPoint: () => ({ x: 500, y: 500 }),
    nearestDisplayWorkArea: () => ({ x: 40, y: 40, width: 1960, height: 1080 }),
    subscribeSnapshot: (listener) => {
      events.push("subscribe-snapshot");
      snapshotListener = listener;
      return unsubscribeSnapshot;
    },
    subscribeDisplayChanges: (listener) => {
      events.push("subscribe-displays");
      displayListener = listener;
      return unsubscribeDisplays;
    },
    openCaptureDetails: vi.fn(),
    reportLoadFailure: vi.fn(),
  } satisfies FloatingCaptureControllerPorts;
  const controller = new FloatingCaptureWindowController(ports);
  return {
    events,
    windows,
    ports,
    controller,
    unsubscribeSnapshot,
    unsubscribeDisplays,
    get enabled() {
      return state.enabled;
    },
    set enabled(value: boolean) {
      state.enabled = value;
    },
    get prominent() {
      return state.prominent;
    },
    set prominent(value: boolean) {
      state.prominent = value;
    },
    get snapshot() {
      return state.snapshot;
    },
    set snapshot(value: FloatingCaptureSnapshot) {
      state.snapshot = value;
    },
    get window() {
      return windows[0]!;
    },
    emitSnapshot() {
      snapshotListener?.(state.snapshot);
    },
    emitEnvironment() {
      controller.reconcileCurrent();
    },
    emitDisplayChange() {
      displayListener?.();
    },
  };
}

class FakeWindow implements FloatingCaptureWindowPort {
  private visible = false;
  private destroyed = false;
  private closeListener: ((event: { preventDefault(): void }) => void) | null =
    null;
  private closedListener: (() => void) | null = null;

  readonly isVisible = vi.fn(() => this.visible);
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly showInactive = vi.fn(() => {
    this.visible = true;
  });
  readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 320, height: 96 }));
  readonly setPosition = vi.fn();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });

  onClose(listener: (event: { preventDefault(): void }) => void): void {
    this.closeListener = listener;
  }

  onClosed(listener: () => void): void {
    this.closedListener = listener;
  }

  emitClose(event: { preventDefault(): void }): void {
    this.closeListener?.(event);
  }

  emitClosed(): void {
    this.destroyed = true;
    this.closedListener?.();
  }
}

function snapshot(
  overrides: Partial<FloatingCaptureSnapshot> = {},
): FloatingCaptureSnapshot {
  return {
    revision: 1,
    sessionId: "session-1",
    phase: "recording",
    elapsedMs: 1_000,
    allowedActions: ["pause", "stop"],
    attention: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
