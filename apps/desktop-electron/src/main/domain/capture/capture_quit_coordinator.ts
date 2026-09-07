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
  | "idle"
  | "confirming"
  | "stopping"
  | "live-failure-choice"
  | "recovered-choice"
  | "unresolved-choice"
  | "tearing-down"
  | "exiting";

export type QuitDecisionKind =
  | "initial"
  | "live-failure"
  | "recovered-failure"
  | "unknown-failure"
  | "unresolved";

export type QuitDecision =
  | "continue-recording"
  | "stop-and-exit"
  | "return-to-app"
  | "return-safe-view"
  | "retry-stop"
  | "continue-waiting"
  | "preserve-and-exit";

export interface CaptureQuitCoordinatorPorts {
  currentCapture(): CaptureSnapshot | null;
  activate(): void;
  dialogParent(): unknown;
  showDecision(kind: QuitDecisionKind, parent: unknown): Promise<QuitDecision>;
  stopAndReconcile(options: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureStopReconciliation>;
  publishCapture(snapshot: CaptureSnapshot | null): void;
  showSafeReturn(destination: "capture" | "recovery" | "disabled"): void;
  suppressCapturePublications(): void;
  abortCapture(): void;
  teardown(mode: "normal" | "recovery-exit"): Promise<void>;
  quit(): void;
  exit(): void;
}

export interface CaptureQuitCoordinatorOptions {
  stopWatchdogMs?: number;
  recoveryExitDeadlineMs?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type SettledStop =
  { kind: "result"; value: CaptureStopReconciliation } | { kind: "error" };

const timedOut = Symbol("capture-stop-watchdog");

export class CaptureQuitCoordinator {
  private readonly stopWatchdogMs: number;
  private readonly recoveryExitDeadlineMs: number;
  private readonly setTimer: NonNullable<
    CaptureQuitCoordinatorOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    CaptureQuitCoordinatorOptions["clearTimer"]
  >;
  private currentPhase: QuitCoordinatorPhase = "idle";
  private generation = 0;
  private activeIntent: Promise<CaptureQuitPreparationOutcome> | null = null;
  private finalExitIssued = false;

  constructor(
    private readonly ports: CaptureQuitCoordinatorPorts,
    options: CaptureQuitCoordinatorOptions = {},
  ) {
    this.stopWatchdogMs = options.stopWatchdogMs ?? 15_000;
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
        return this.cancel(generation, "capture");
      }
    }

    return await this.stopUntilDecision(generation, capture, interactive);
  }

  private async stopUntilDecision(
    generation: number,
    capture: CaptureSnapshot,
    interactive: boolean,
  ): Promise<CaptureQuitPreparationOutcome> {
    let attempt = 0;
    while (this.isActive(generation)) {
      this.currentPhase = "stopping";
      const settled: Promise<SettledStop> = this.ports
        .stopAndReconcile({
          sessionId: capture.sessionId,
          idempotencyKey: `stop-quit-${capture.sessionId}-${generation}-${attempt++}`,
        })
        .then(
          (value): SettledStop => ({ kind: "result", value }),
          (): SettledStop => ({ kind: "error" }),
        );
      const first = await this.withWatchdog(settled);
      if (!this.isActive(generation)) return "cancelled";

      let stop: SettledStop;
      if (first === timedOut) {
        if (!interactive) return await this.recoveryExit(generation);
        this.currentPhase = "unresolved-choice";
        const decision = this.ports.showDecision(
          "unresolved",
          this.ports.dialogParent(),
        );
        const next = await Promise.race([
          settled.then((value) => ({ kind: "stop" as const, value })),
          decision.then((value) => ({ kind: "decision" as const, value })),
        ]);
        if (!this.isActive(generation)) return "cancelled";
        if (next.kind === "decision") {
          if (next.value === "preserve-and-exit") {
            return await this.recoveryExit(generation);
          }
          // Continuing waits on the original invocation. It deliberately does
          // not create another watchdog, stop request, or dialog.
          stop = await settled;
        } else {
          stop = next.value;
        }
      } else {
        stop = first;
      }

      const result = stop.kind === "result" ? stop.value : unknownStopResult();
      if (result.snapshot) this.ports.publishCapture(result.snapshot);
      if (result.snapshot && isDurableTerminal(result.snapshot)) {
        return await this.commitAndExit(generation);
      }
      if (!interactive) return await this.recoveryExit(generation);

      if (result.capability === "live-stoppable") {
        this.currentPhase = "live-failure-choice";
        const decision = await this.ports.showDecision(
          "live-failure",
          this.ports.dialogParent(),
        );
        if (!this.isActive(generation)) return "cancelled";
        if (decision === "retry-stop") continue;
        if (decision === "preserve-and-exit") {
          return await this.recoveryExit(generation);
        }
        return this.cancel(generation, "capture");
      }

      this.currentPhase = "recovered-choice";
      const recovered = result.capability === "recovered-terminal";
      const decision = await this.ports.showDecision(
        recovered ? "recovered-failure" : "unknown-failure",
        this.ports.dialogParent(),
      );
      if (!this.isActive(generation)) return "cancelled";
      if (decision === "preserve-and-exit") {
        return await this.recoveryExit(generation);
      }
      return this.cancel(generation, recovered ? "recovery" : "disabled");
    }
    return "cancelled";
  }

  private async withWatchdog(
    stop: Promise<SettledStop>,
  ): Promise<SettledStop | typeof timedOut> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<typeof timedOut>((resolve) => {
      timer = this.setTimer(() => resolve(timedOut), this.stopWatchdogMs);
    });
    const result = await Promise.race([stop, watchdog]);
    if (result !== timedOut && timer) this.clearTimer(timer);
    return result;
  }

  private cancel(
    generation: number,
    destination: "capture" | "recovery" | "disabled",
  ): CaptureQuitPreparationOutcome {
    if (this.isActive(generation)) {
      this.generation += 1;
      this.currentPhase = "idle";
      this.ports.showSafeReturn(destination);
    }
    return "cancelled";
  }

  private async commitAndExit(
    generation: number,
  ): Promise<CaptureQuitPreparationOutcome> {
    if (!this.isActive(generation)) return "cancelled";
    this.currentPhase = "tearing-down";
    await this.ports.teardown("normal");
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = this.setTimer(resolve, this.recoveryExitDeadlineMs);
    });
    try {
      this.ports.abortCapture();
    } catch {
      // The absolute deadline and final exit remain authoritative even when
      // the out-of-band helper termination itself reports a synchronous error.
    }
    let cleanup: Promise<void>;
    try {
      cleanup = Promise.resolve(
        this.ports.teardown("recovery-exit"),
      ).catch(() => undefined);
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
