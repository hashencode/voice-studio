import type { CaptureSnapshot } from "../../../shared/contracts";
import {
  isDurableTerminal,
  type CaptureStopReconciliation,
} from "./desktop_capture_service";
import {
  captureRequiresQuitConfirmation,
  type CaptureQuitPreparationOutcome,
} from "./capture_lifecycle_policy";

export type QuitCoordinatorPhase =
  "idle" | "confirming" | "stopping" | "tearing-down" | "exiting";

export type QuitDecisionKind = "initial";

export type QuitDecision = "continue-recording" | "stop-and-exit";

export interface CaptureQuitCoordinatorPorts {
  currentCapture(): CaptureSnapshot | null;
  activate(): void;
  dialogParent(): unknown;
  showDecision(kind: QuitDecisionKind, parent: unknown): Promise<QuitDecision>;
  stopAndReconcile(options: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureStopReconciliation>;
  returnToCapture(): void;
  suppressCapturePublications(): void;
  abortCapture(): void;
  teardown(mode: "normal" | "recovery-exit"): Promise<void>;
  quit(): void;
  exit(): void;
}

export interface CaptureQuitCoordinatorOptions {
  recoveryExitDeadlineMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class CaptureQuitCoordinator {
  private readonly recoveryExitDeadlineMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private currentPhase: QuitCoordinatorPhase = "idle";
  private generation = 0;
  private activeIntent: Promise<CaptureQuitPreparationOutcome> | null = null;
  private finalExitIssued = false;

  constructor(
    private readonly ports: CaptureQuitCoordinatorPorts,
    options: CaptureQuitCoordinatorOptions = {},
  ) {
    this.recoveryExitDeadlineMs = options.recoveryExitDeadlineMs ?? 5_000;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get phase(): QuitCoordinatorPhase {
    return this.currentPhase;
  }

  get allowsNativeQuit(): boolean {
    return this.currentPhase === "exiting";
  }

  requestInteractive(): Promise<CaptureQuitPreparationOutcome> {
    return this.request(true);
  }

  requestNonInteractive(): Promise<CaptureQuitPreparationOutcome> {
    return this.request(false);
  }

  private request(
    interactive: boolean,
  ): Promise<CaptureQuitPreparationOutcome> {
    if (this.activeIntent) return this.activeIntent;
    const generation = ++this.generation;
    const intent = this.runIntent(generation, interactive).finally(() => {
      if (this.activeIntent === intent && this.currentPhase === "idle") {
        this.activeIntent = null;
      }
    });
    this.activeIntent = intent;
    return intent;
  }

  private async runIntent(
    generation: number,
    interactive: boolean,
  ): Promise<CaptureQuitPreparationOutcome> {
    const capture = this.ports.currentCapture();
    if (!capture || !captureRequiresQuitConfirmation(capture)) {
      return await this.commitAndExit(generation);
    }

    if (interactive) {
      this.currentPhase = "confirming";
      this.ports.activate();
      const decision = await this.ports.showDecision(
        "initial",
        this.ports.dialogParent(),
      );
      if (!this.isActive(generation)) return "cancelled";
      if (decision !== "stop-and-exit") {
        return this.cancel(generation);
      }
    }

    return await this.stopAndExit(generation, capture);
  }

  private async stopAndExit(
    generation: number,
    capture: CaptureSnapshot,
  ): Promise<CaptureQuitPreparationOutcome> {
    this.currentPhase = "stopping";
    let result: CaptureStopReconciliation;
    try {
      result = await this.ports.stopAndReconcile({
        sessionId: capture.sessionId,
        idempotencyKey: `stop-quit-${capture.sessionId}-${generation}`,
      });
    } catch {
      result = unknownStopResult();
    }
    if (!this.isActive(generation)) return "cancelled";
    if (result.snapshot && isDurableTerminal(result.snapshot)) {
      return await this.commitAndExit(generation);
    }
    return await this.recoveryExit(generation);
  }

  private cancel(generation: number): CaptureQuitPreparationOutcome {
    if (this.isActive(generation)) {
      this.generation += 1;
      this.currentPhase = "idle";
      this.ports.returnToCapture();
    }
    return "cancelled";
  }

  private async commitAndExit(
    generation: number,
  ): Promise<CaptureQuitPreparationOutcome> {
    if (!this.isActive(generation)) return "cancelled";
    this.currentPhase = "tearing-down";
    try {
      await this.ports.teardown("normal");
    } catch {
      if (!this.isActive(generation)) return "cancelled";
      this.currentPhase = "exiting";
      this.issueFinalExit();
      return "committed";
    }
    if (!this.isActive(generation)) return "cancelled";
    this.currentPhase = "exiting";
    this.ports.quit();
    return "committed";
  }

  private async recoveryExit(
    generation: number,
  ): Promise<CaptureQuitPreparationOutcome> {
    if (!this.isActive(generation)) return "cancelled";
    this.generation += 1;
    this.currentPhase = "tearing-down";
    this.ports.suppressCapturePublications();

    try {
      this.ports.abortCapture();
    } catch {
      // Reconciliation has already persisted the safest available state.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = this.setTimer(resolve, this.recoveryExitDeadlineMs);
    });
    let cleanup: Promise<void>;
    try {
      cleanup = Promise.resolve(this.ports.teardown("recovery-exit")).catch(
        () => undefined,
      );
    } catch {
      cleanup = Promise.resolve();
    }
    await Promise.race([cleanup, deadline]);
    if (timer) this.clearTimer(timer);
    this.currentPhase = "exiting";
    this.issueFinalExit();
    return "recoverable-exit";
  }

  private issueFinalExit(): void {
    if (this.finalExitIssued) return;
    this.finalExitIssued = true;
    this.ports.exit();
  }

  private isActive(generation: number): boolean {
    return this.generation === generation;
  }
}

function unknownStopResult(): CaptureStopReconciliation {
  return { snapshot: null, capability: "unknown" };
}
