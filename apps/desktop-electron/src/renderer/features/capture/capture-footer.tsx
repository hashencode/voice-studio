import * as React from "react";
import { CirclePause, Play, Square } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { CaptureCompactAction, CaptureView } from "./capture-presentation";
import { formatCaptureElapsed } from "./capture-presentation";

const FIXED_WAVEFORM = [
  { height: 28, delay: -0.54, duration: 0.82 },
  { height: 52, delay: -0.22, duration: 0.96 },
  { height: 78, delay: -0.67, duration: 1.08 },
  { height: 44, delay: -0.35, duration: 0.88 },
  { height: 92, delay: -0.74, duration: 1.12 },
  { height: 64, delay: -0.18, duration: 0.94 },
  { height: 36, delay: -0.49, duration: 0.84 },
  { height: 72, delay: -0.63, duration: 1.04 },
  { height: 48, delay: -0.28, duration: 0.9 },
  { height: 86, delay: -0.71, duration: 1.1 },
  { height: 58, delay: -0.4, duration: 0.98 },
  { height: 32, delay: -0.12, duration: 0.8 },
  { height: 68, delay: -0.57, duration: 1.02 },
  { height: 42, delay: -0.32, duration: 0.86 },
  { height: 82, delay: -0.69, duration: 1.06 },
  { height: 54, delay: -0.24, duration: 0.92 },
] as const;

type CaptureFooterProps = {
  capture: CaptureView;
  busy: boolean;
  stopConfirmationOpen: boolean;
  stopSubmitted: boolean;
  statusOverride?: string;
  onCancelStop: () => void;
  onConfirmStop: () => void;
  onControl: (action: CaptureCompactAction) => void;
};

export function CaptureFooter({
  capture,
  busy,
  stopConfirmationOpen,
  stopSubmitted,
  statusOverride,
  onCancelStop,
  onConfirmStop,
  onControl,
}: CaptureFooterProps) {
  const presentation = footerPresentation(capture);
  const controlsDisabled =
    busy || stopSubmitted || presentation.controlsDisabled;
  const acceptsActivity =
    capture.phase === "recording" ||
    (capture.phase === "partial_capture" &&
      Boolean(capture.systemAudioHealthy || capture.microphoneHealthy));
  const inputActive = acceptsActivity && (capture.audioActivity ?? 0) > 0;

  return (
    <div
      data-capture-footer="true"
      className="flex w-full flex-nowrap items-center justify-between gap-6 px-4 py-3"
    >
      <div className="flex min-w-0 flex-nowrap items-center gap-4">
        <p className="shrink-0 text-sm font-medium">
          {statusOverride ?? presentation.status}
        </p>
        <p className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {formatCaptureElapsed(capture.elapsedMs)}
        </p>
        <CaptureActivity inputActive={inputActive} />
      </div>
      {presentation.action ? (
        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => onControl(presentation.action!)}
          >
            {presentation.action === "pause" ? (
              <CirclePause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {presentation.actionLabel}
          </Button>
          {presentation.controlsDisabled ? (
            <Button type="button" size="sm" variant="destructive" disabled>
              <Square aria-hidden="true" />
              停止并保存
            </Button>
          ) : (
            <AlertDialog
              open={stopConfirmationOpen}
              onOpenChange={(open) => {
                if (busy || stopSubmitted) return;
                if (open) onControl("stop");
                else onCancelStop();
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={controlsDisabled}
                >
                  <Square aria-hidden="true" />
                  停止并保存
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认停止并保存</AlertDialogTitle>
                  <AlertDialogDescription className="sr-only">
                    确认停止录制
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel asChild>
                    <Button type="button" variant="outline" disabled={busy}>
                      取消
                    </Button>
                  </AlertDialogCancel>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={onConfirmStop}
                  >
                    <Square aria-hidden="true" />
                    {busy ? "正在保存…" : "确认停止并保存"}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      ) : null}
    </div>
  );
}

const CaptureActivity = React.memo(function CaptureActivity({
  inputActive,
}: {
  inputActive: boolean;
}) {
  return (
    <div
      role="img"
      aria-label="录音活动"
      data-input-active={String(inputActive)}
      className="flex h-6 w-32 shrink-0 items-center gap-0.5 overflow-hidden"
    >
      {FIXED_WAVEFORM.map(({ height, delay, duration }, index) => (
        <span
          key={index}
          aria-hidden="true"
          data-testid="capture-activity-sample"
          className="capture-activity-bar min-h-0.5 flex-1 rounded-full bg-primary/70"
          style={
            {
              "--capture-bar-height": `${height}%`,
              "--capture-bar-delay": `${delay}s`,
              "--capture-bar-duration": `${duration}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
});

function footerPresentation(capture: CaptureView): {
  status: string;
  action: "pause" | "resume" | null;
  actionLabel: string | null;
  controlsDisabled: boolean;
} {
  const partialRunning =
    capture.phase === "partial_capture" &&
    Boolean(capture.systemAudioHealthy || capture.microphoneHealthy);
  if (capture.phase === "preflight" || capture.phase === "preparing") {
    return {
      status: "正在开始录制",
      action: "pause",
      actionLabel: "暂停录制",
      controlsDisabled: true,
    };
  }
  if (capture.phase === "recording" || partialRunning) {
    return {
      status: partialRunning ? "部分录制" : "正在录制",
      action: "pause",
      actionLabel: "暂停录制",
      controlsDisabled: false,
    };
  }
  if (capture.phase === "paused") {
    const wakeRequiresResume =
      capture.interruptionReason === "system_wake_requires_resume";
    return {
      status: wakeRequiresResume ? "等待你确认继续录制" : "录制已暂停",
      action: "resume",
      actionLabel: wakeRequiresResume ? "确认并继续录制" : "继续录制",
      controlsDisabled: false,
    };
  }
  if (capture.phase === "finalizing") {
    return {
      status:
        capture.interruptionReason === "capture_stop_slow"
          ? "保存时间比预期长，仍在继续保存…"
          : "正在保存录音…",
      action: "pause",
      actionLabel: "暂停录制",
      controlsDisabled: true,
    };
  }
  if (capture.phase === "recovery") {
    return terminalFooterPresentation("录制需要恢复");
  }
  if (capture.phase === "completed") {
    return terminalFooterPresentation("录制已保存");
  }
  if (capture.phase === "partial_capture") {
    return terminalFooterPresentation("部分录制已保存");
  }
  return terminalFooterPresentation("录制需要处理");
}

function terminalFooterPresentation(status: string): {
  status: string;
  action: null;
  actionLabel: null;
  controlsDisabled: true;
} {
  return {
    status,
    action: null,
    actionLabel: null,
    controlsDisabled: true,
  };
}
