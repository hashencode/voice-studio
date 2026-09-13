import type {
  CaptureSnapshot,
  FloatingCaptureControlRequest,
  FloatingCaptureSnapshot,
} from "../../shared/contracts";
import type { CaptureStopReconciliation } from "../domain/capture/desktop_capture_service";

interface FloatingCaptureControlPorts {
  handoffToMain(): void;
  reportHandoffFailure?(): void;
  controlCapture(options: FloatingCaptureControlRequest): Promise<unknown>;
  currentSnapshot(): FloatingCaptureSnapshot;
}

export async function runFloatingCaptureControl(
  options: FloatingCaptureControlRequest,
  ports: FloatingCaptureControlPorts,
): Promise<FloatingCaptureSnapshot> {
  if (options.action === "stop") {
    try {
      ports.handoffToMain();
    } catch {
      ports.reportHandoffFailure?.();
    }
  }
  await ports.controlCapture(options);
  return ports.currentSnapshot();
}

interface StopOnlyCapturePorts {
  currentCapture(): CaptureSnapshot | null;
  publishCapture(snapshot: CaptureSnapshot): void;
  stopAndReconcile(options: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureStopReconciliation>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export async function runStopOnlyCapture(
  options: { sessionId: string; idempotencyKey: string },
  ports: StopOnlyCapturePorts,
): Promise<CaptureSnapshot | null> {
  const current = ports.currentCapture();
  const setTimer = ports.setTimer ?? setTimeout;
  const clearTimer = ports.clearTimer ?? clearTimeout;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (current?.sessionId === options.sessionId) {
    ports.publishCapture({
      ...current,
      state: "finalizing",
      interruptionReason: null,
    });
    watchdog = setTimer(() => {
      const pending = ports.currentCapture();
      if (pending?.sessionId !== options.sessionId) return;
      ports.publishCapture({
        ...pending,
        state: "finalizing",
        interruptionReason: "capture_stop_slow",
      });
    }, 15_000);
  }
  try {
    return (await ports.stopAndReconcile(options)).snapshot;
  } finally {
    if (watchdog) clearTimer(watchdog);
  }
}
