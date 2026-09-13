import type {
  FloatingCaptureSnapshot,
  FloatingCaptureWindowAction,
} from "../../../shared/contracts";
import { hasSameFloatingCapturePresentation } from "../../application/floating_capture_projection";

export interface FloatingCaptureWindowPort {
  isVisible(): boolean;
  isDestroyed(): boolean;
  hide(): void;
  showInactive(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setPosition(x: number, y: number, animate: boolean): void;
  destroy(): void;
  onClose(listener: (event: { preventDefault(): void }) => void): void;
  onClosed(listener: () => void): void;
}

export interface FloatingCaptureControllerPorts<
  RegistrationTarget = FloatingCaptureWindowPort,
> {
  currentSnapshot(): FloatingCaptureSnapshot;
  mainIsProminent(): boolean;
  createWindow(): {
    window: FloatingCaptureWindowPort;
    load: Promise<void>;
    registrationTarget: RegistrationTarget;
  };
  registerWindow(target: RegistrationTarget): () => void;
  readPreference(): boolean;
  writePreference(enabled: boolean): Promise<void>;
  cursorPoint(): { x: number; y: number };
  nearestDisplayWorkArea(point: { x: number; y: number }): {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  subscribeSnapshot(
    listener: (snapshot: FloatingCaptureSnapshot) => void,
  ): () => void;
  subscribeDisplayChanges(listener: () => void): () => void;
  openCaptureDetails(): void;
  reportLoadFailure(error: unknown): void;
}

const teardownError =
  "floating capture controller is unavailable during teardown";

export class FloatingCaptureWindowController<
  RegistrationTarget = FloatingCaptureWindowPort,
> {
  private window: FloatingCaptureWindowPort | null = null;
  private windowRegistrationTarget: {
    window: FloatingCaptureWindowPort;
    value: RegistrationTarget;
  } | null = null;
  private unregisterWindow: (() => void) | null = null;
  private unregisterSnapshot: (() => void) | null = null;
  private unregisterDisplays: (() => void) | null = null;
  private readonly listeners = new Set<
    (snapshot: FloatingCaptureSnapshot) => void
  >();
  private enabled = false;
  private initialized = false;
  private fenced = false;
  private suppressedSessionId: string | null = null;
  private loadFailedSessionId: string | null = null;
  private presentedSessionId: string | null = null;
  private lastPresentation: FloatingCaptureSnapshot | null = null;
  private preferenceMutation: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly ports: FloatingCaptureControllerPorts<RegistrationTarget>,
  ) {}

  initialize(): void {
    if (this.initialized) return;
    if (this.fenced) throw new Error(teardownError);

    try {
      this.enabled = this.ports.readPreference();
    } catch {
      this.enabled = false;
    }
    this.unregisterSnapshot = this.ports.subscribeSnapshot((snapshot) =>
      this.acceptSnapshot(snapshot),
    );
    this.unregisterDisplays = this.ports.subscribeDisplayChanges(() => {
      if (!this.fenced) this.reconcile(this.ports.currentSnapshot(), true);
    });
    this.initialized = true;
    this.acceptSnapshot(this.ports.currentSnapshot());
  }

  getPreference(): { enabled: boolean } {
    return { enabled: this.enabled };
  }

  setPreference(enabled: boolean): Promise<{ enabled: boolean }> {
    if (this.fenced) return Promise.reject(new Error(teardownError));

    const operation = this.preferenceMutation.then(async () => {
      await this.ports.writePreference(enabled);
      this.enabled = enabled;
      this.suppressedSessionId = null;
      this.loadFailedSessionId = null;
      if (!enabled) {
        this.hideWindow();
      } else if (!this.fenced) {
        this.reconcile(this.ports.currentSnapshot());
      }
      return { enabled };
    });
    this.preferenceMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  onSnapshot(
    listener: (snapshot: FloatingCaptureSnapshot) => void,
  ): () => void {
    if (this.fenced) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async handleWindowAction(
    action: FloatingCaptureWindowAction,
  ): Promise<FloatingCaptureSnapshot> {
    if (this.fenced) throw new Error(teardownError);
    const snapshot = this.ports.currentSnapshot();
    if (action === "hide") {
      this.suppressedSessionId = snapshot.sessionId;
      this.hideWindow();
    } else if (action === "turn-off") {
      await this.setPreference(false);
    } else {
      this.hideWindow();
      this.ports.openCaptureDetails();
    }
    return snapshot;
  }

  hideWindow(): void {
    const window = this.liveWindow();
    if (window?.isVisible()) window.hide();
    this.presentedSessionId = null;
  }

  reconcileCurrent(): void {
    if (!this.fenced) this.reconcile(this.ports.currentSnapshot());
  }

  rebindIpc(): void {
    if (this.fenced) return;
    const window = this.liveWindow();
    if (!window) return;
    this.unregisterWindow?.();
    this.unregisterWindow = null;
    this.unregisterWindow = this.ports.registerWindow(
      this.registrationTarget(window),
    );
  }

  beginTeardown(): Promise<void> {
    this.fenced = true;
    return this.preferenceMutation;
  }

  completeTeardown(): Promise<void> {
    this.disposal ??= this.dispose();
    return this.disposal;
  }

  private acceptSnapshot(snapshot: FloatingCaptureSnapshot): void {
    if (this.fenced) return;
    if (
      snapshot.sessionId === null ||
      snapshot.sessionId !== this.suppressedSessionId
    ) {
      this.suppressedSessionId = null;
    }
    if (
      snapshot.sessionId === null ||
      snapshot.sessionId !== this.loadFailedSessionId
    ) {
      this.loadFailedSessionId = null;
    }
    if (hasSameFloatingCapturePresentation(this.lastPresentation, snapshot)) {
      return;
    }
    this.lastPresentation = snapshot;
    this.reconcile(snapshot);
    if (this.liveWindow()?.isVisible()) {
      for (const listener of this.listeners) listener(snapshot);
    }
  }

  private reconcile(
    snapshot: FloatingCaptureSnapshot,
    forcePosition = false,
  ): void {
    if (this.fenced) return;
    const active = snapshot.phase !== "idle";
    if (
      !this.enabled ||
      !active ||
      this.ports.mainIsProminent() ||
      snapshot.sessionId === this.suppressedSessionId
    ) {
      this.hideWindow();
      return;
    }
    if (snapshot.sessionId === this.loadFailedSessionId) return;

    const window = this.liveWindow() ?? this.createWindow(snapshot.sessionId);
    const visible = window.isVisible();
    if (
      !forcePosition &&
      visible &&
      this.presentedSessionId === snapshot.sessionId
    ) {
      return;
    }

    const workArea = this.ports.nearestDisplayWorkArea(
      this.ports.cursorPoint(),
    );
    const bounds = window.getBounds();
    const x = workArea.x + workArea.width - bounds.width - 16;
    const y = workArea.y + 16;
    if (bounds.x !== x || bounds.y !== y) window.setPosition(x, y, false);
    if (!visible) window.showInactive();
    this.presentedSessionId = snapshot.sessionId;
  }

  private createWindow(sessionId: string | null): FloatingCaptureWindowPort {
    const created = this.ports.createWindow();
    const window = created.window;
    window.onClose((event) => {
      if (this.fenced || this.window !== window) return;
      event.preventDefault();
      this.suppressedSessionId = this.ports.currentSnapshot().sessionId;
      window.hide();
      this.presentedSessionId = null;
    });
    window.onClosed(() => this.retireWindow(window, false));
    this.window = window;
    this.windowRegistrationTarget = {
      window,
      value: created.registrationTarget,
    };
    try {
      this.unregisterWindow = this.ports.registerWindow(
        created.registrationTarget,
      );
    } catch (error) {
      this.retireWindow(window, true);
      throw error;
    }
    void created.load.catch((error: unknown) => {
      if (this.fenced || this.window !== window || window.isDestroyed()) {
        return;
      }
      const currentSnapshot = this.ports.currentSnapshot();
      if (currentSnapshot.sessionId === sessionId) {
        this.loadFailedSessionId = sessionId;
      }
      try {
        this.ports.reportLoadFailure(error);
      } catch {
        // Diagnostics must not prevent the failed window from being retired.
      }
      this.retireWindow(window, true);
      if (currentSnapshot.sessionId !== sessionId && !this.fenced) {
        this.reconcile(currentSnapshot);
      }
    });
    return window;
  }

  private liveWindow(): FloatingCaptureWindowPort | null {
    if (this.window?.isDestroyed()) this.retireWindow(this.window, false);
    return this.window;
  }

  private registrationTarget(
    window: FloatingCaptureWindowPort,
  ): RegistrationTarget {
    const target = this.windowRegistrationTarget;
    if (!target || target.window !== window) {
      throw new Error(
        "floating capture window registration target is unavailable",
      );
    }
    return target.value;
  }

  private retireWindow(
    window: FloatingCaptureWindowPort,
    destroy: boolean,
  ): void {
    if (this.window !== window) return;
    this.unregisterWindow?.();
    this.unregisterWindow = null;
    this.window = null;
    this.windowRegistrationTarget = null;
    this.presentedSessionId = null;
    if (destroy && !window.isDestroyed()) window.destroy();
  }

  private async dispose(): Promise<void> {
    await this.beginTeardown();
    this.unregisterSnapshot?.();
    this.unregisterSnapshot = null;
    this.unregisterDisplays?.();
    this.unregisterDisplays = null;
    this.listeners.clear();
    const window = this.liveWindow();
    if (window) this.retireWindow(window, true);
  }
}
