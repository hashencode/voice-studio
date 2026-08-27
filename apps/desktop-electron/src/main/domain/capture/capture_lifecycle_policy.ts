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
