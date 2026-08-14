import { CirclePause, Mic2 } from "lucide-react";

import type { ApplicationSnapshot } from "@shared/contracts";

export function CaptureWorkspaceOverlay({
  capture,
}: {
  capture: ApplicationSnapshot["capture"];
}) {
  if (capture.phase === "idle") return null;
  const paused = capture.phase === "paused";
  const label = capturePhaseLabel(capture.phase);
  return (
    <aside
      role="complementary"
      aria-label="录制工作区"
      className="fixed right-5 bottom-5 z-30 w-[min(24rem,calc(100vw-2.5rem))] rounded-xl border bg-card p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          {paused ? (
            <CirclePause className="size-5" aria-hidden="true" />
          ) : (
            <Mic2 className="size-5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <h2 className="truncate font-semibold">{capture.title}</h2>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {formatElapsed(capture.elapsedMs)} · 切换页面不会停止此会话
          </p>
          {capture.message ? (
            <p className="mt-2 text-sm">{capture.message}</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function capturePhaseLabel(
  phase: Exclude<ApplicationSnapshot["capture"]["phase"], "idle">,
): string {
  return {
    preflight: "正在检查录制条件",
    recording: "正在录制",
    paused: "录制已暂停",
    finalizing: "正在安全结束录制",
    recovery: "录制等待恢复",
    failed: "录制需要处理",
  }[phase];
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
