import type {
  ApplicationSnapshot,
  FloatingCaptureSnapshot,
} from "../../shared/contracts";

export function deriveFloatingCaptureSnapshot(
  application: ApplicationSnapshot,
): FloatingCaptureSnapshot {
  const capture = application.capture;
  if (capture.phase === "idle" || capture.phase === "completed") {
    return {
      revision: application.revision,
      sessionId: null,
      phase: "idle",
      elapsedMs: 0,
      allowedActions: [],
      attention: false,
    };
  }
  const running =
    capture.phase === "recording" ||
    (capture.phase === "partial_capture" &&
      Boolean(capture.systemAudioHealthy || capture.microphoneHealthy));
  const paused = capture.phase === "paused";
  const attention =
    capture.phase === "failed" ||
    capture.phase === "recovery" ||
    (capture.phase === "partial_capture" && !running);
  return {
    revision: application.revision,
    sessionId: capture.sessionId,
    phase: attention
      ? "attention"
      : running
        ? "recording"
        : paused
          ? "paused"
          : "finalizing",
    elapsedMs: capture.elapsedMs,
    allowedActions: running
      ? ["pause", "stop"]
      : paused
        ? ["resume", "stop"]
        : [],
    attention,
  };
}

export function hasSameFloatingCapturePresentation(
  left: FloatingCaptureSnapshot | null,
  right: FloatingCaptureSnapshot,
): boolean {
  return (
    left !== null &&
    left.sessionId === right.sessionId &&
    left.phase === right.phase &&
    left.elapsedMs === right.elapsedMs &&
    left.attention === right.attention &&
    left.allowedActions.length === right.allowedActions.length &&
    left.allowedActions.every(
      (action, index) => action === right.allowedActions[index],
    )
  );
}
