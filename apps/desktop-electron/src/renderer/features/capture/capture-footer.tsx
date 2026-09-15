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
                  <AlertDialogTitle>提示</AlertDialogTitle>
                  <AlertDialogDescription>
                    停止录制后，当前内容将自动保存。
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
                    disabled={busy}
                    onClick={onConfirmStop}
                  >
                    {busy ? "正在保存…" : "确定"}
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
