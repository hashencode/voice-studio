import type {
  ApplicationSnapshot,
  CaptureControlRequest,
} from "@shared/contracts";

export type CaptureView = Exclude<
  ApplicationSnapshot["capture"],
  { phase: "idle" }
>;

export type CaptureCompactAction = CaptureControlRequest["action"];

export interface CaptureCompactPresentation {
  sessionId: string;
  phase: CaptureView["phase"];
  status: string;
  elapsed: string;
  action: CaptureCompactAction | null;
  canStop: boolean;
  needsAttention: boolean;
  indicator: string | null;
}

export function deriveCaptureCompactPresentation(
  capture: ApplicationSnapshot["capture"],
): CaptureCompactPresentation | null {
  if (capture.phase === "idle" || capture.phase === "completed") return null;

  const running =
    capture.phase === "recording" ||
    (capture.phase === "partial_capture" &&
      Boolean(capture.systemAudioHealthy || capture.microphoneHealthy));
  const paused = capture.phase === "paused";
  const needsAttention =
    capture.phase === "failed" ||
    capture.phase === "recovery" ||
    (capture.phase === "partial_capture" && !running);

  return {
    sessionId: capture.sessionId,
    phase: capture.phase,
    status: capturePhaseLabel(capture.phase, capture.interruptionReason),
    elapsed: formatCaptureElapsed(capture.elapsedMs),
    action: running ? "pause" : paused ? "resume" : null,
    canStop: running || paused,
    needsAttention,
    indicator:
      capture.phase === "partial_capture" || capture.partialCapture
        ? "部分轨道"
        : capture.interruptionReason === "system_wake_requires_resume"
          ? "需要确认"
          : null,
  };
}

export function capturePhaseLabel(
  phase: CaptureView["phase"],
  interruptionReason?: string | null,
): string {
  if (
    phase === "paused" &&
    interruptionReason === "system_wake_requires_resume"
  ) {
    return "等待继续";
  }
  if (phase === "paused" && interruptionReason === "system_sleep") {
    return "睡眠暂停";
  }
  return {
    preflight: "检查中",
    preparing: "准备中",
    recording: "录制中",
    paused: "已暂停",
    finalizing: "保存中",
    completed: "已保存",
    recovery: "需要恢复",
    partial_capture: "部分录制",
    failed: "需要处理",
  }[phase];
}

export function formatCaptureElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
