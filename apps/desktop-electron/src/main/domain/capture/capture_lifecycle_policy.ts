import type { CaptureSnapshot } from "../../../shared/contracts";

export const activeCaptureQuitDialog = Object.freeze({
  type: "warning" as const,
  title: "录制仍在进行",
  message: "要继续录制，还是停止并安全保存后退出？",
  detail: "选择停止后，应用会先保存当前录制再退出。",
  buttons: ["继续录制", "停止并保存后退出"],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

export const liveCaptureStopFailureDialog = Object.freeze({
  type: "warning" as const,
  title: "录制尚未保存",
  message: "停止录制失败。你可以返回录制、重试，或保留恢复数据后退出。",
  detail: "保留恢复数据不会丢弃录制；下次启动时可以继续处理。",
  buttons: ["返回录制", "重试停止", "保留恢复数据并退出"],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

export const recoveredCaptureStopFailureDialog = Object.freeze({
  type: "warning" as const,
  title: "录制尚未保存",
  message: "录制控制已中断，但恢复数据仍然保留。",
  detail: "你可以返回恢复页面，或保留恢复数据后退出。",
  buttons: ["返回恢复页面", "保留恢复数据并退出"],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

export const unknownCaptureStopFailureDialog = Object.freeze({
  type: "warning" as const,
  title: "录制尚未保存",
  message: "暂时无法确认录制状态。",
  detail: "你可以返回查看停用的录制页面，或保留恢复数据后退出。",
  buttons: ["返回查看", "保留恢复数据并退出"],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

export const unresolvedCaptureStopDialog = Object.freeze({
  type: "warning" as const,
  title: "仍在停止录制",
  message: "保存还没有完成，录制控制仍在等待响应。",
  detail: "你可以继续等待，或保留现有恢复数据后退出。",
  buttons: ["继续等待", "保留恢复数据并退出"],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

export type CaptureQuitPreparationOutcome =
  "cancelled" | "committed" | "recoverable-exit";

export function captureIsRunning(snapshot: CaptureSnapshot): boolean {
  return (
    snapshot.state === "recording" ||
    (snapshot.state === "partial_capture" &&
      (snapshot.systemAudioHealthy || snapshot.microphoneHealthy))
  );
}

export function captureRequiresSnapshotPolling(
  snapshot: CaptureSnapshot,
): boolean {
  return (
    captureIsRunning(snapshot) ||
    ["preparing", "paused", "finalizing"].includes(snapshot.state)
  );
}

export function captureRequiresQuitConfirmation(
  snapshot: CaptureSnapshot | null,
): boolean {
  return Boolean(
    snapshot && (captureIsRunning(snapshot) || snapshot.state === "paused"),
  );
}
