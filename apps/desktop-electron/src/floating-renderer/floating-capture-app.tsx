import * as React from "react";
import {
  CirclePause,
  ExternalLink,
  Mic2,
  Play,
  Power,
  Square,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FloatingCaptureSnapshot } from "@shared/contracts";
import { formatCaptureElapsed } from "@/features/capture/capture-presentation";

let commandSequence = 0;

export function FloatingCaptureApp() {
  const [snapshot, setSnapshot] =
    React.useState<FloatingCaptureSnapshot | null>(null);
  const [pending, setPending] = React.useState(false);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [controlError, setControlError] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);

  const accept = React.useCallback((next: FloatingCaptureSnapshot) => {
    setSnapshot((current) =>
      !current || next.revision > current.revision ? next : current,
    );
  }, []);

  React.useEffect(() => {
    let active = true;
    const unsubscribe = window.voice2textFloating.onSnapshot((value) => {
      if (!active) return;
      accept(value);
      setLoadError(false);
      if (!value.allowedActions.includes("stop")) setConfirmStop(false);
    });
    void window.voice2textFloating
      .getSnapshot()
      .then((value) => {
        if (active) accept(value);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmStop) setConfirmStop(false);
      else void window.voice2textFloating.windowAction("hide");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmStop]);

  const control = async (action: "pause" | "resume" | "stop") => {
    if (!snapshot?.sessionId || pending) return;
    setPending(true);
    try {
      accept(
        await window.voice2textFloating.control({
          action,
          sessionId: snapshot.sessionId,
          idempotencyKey: `${action}-floating-${Date.now()}-${++commandSequence}`,
        }),
      );
      setControlError(false);
    } catch {
      setControlError(true);
    } finally {
      setPending(false);
    }
  };

  if (!snapshot) {
    return loadError ? (
      <main className="floating-shell" aria-label="Voice2Text 录制悬浮控制">
        <span className="status-mark" aria-hidden="true">
          <Mic2 />
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium" role="alert">
          状态暂不可用
        </p>
        <div className="no-drag flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="打开录制详情"
            onClick={() =>
              void window.voice2textFloating.windowAction("open-details")
            }
          >
            <ExternalLink aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="隐藏本次录制的悬浮控制"
            onClick={() => void window.voice2textFloating.windowAction("hide")}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </main>
    ) : null;
  }
  if (snapshot.phase === "idle") return null;
  const canPause = snapshot.allowedActions.includes("pause");
  const canResume = snapshot.allowedActions.includes("resume");
  const canStop = snapshot.allowedActions.includes("stop");

  return (
    <main className="floating-shell" aria-label="Voice2Text 录制悬浮控制">
      <span className="status-mark" aria-hidden="true">
        <Mic2 />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" role="status" aria-live="polite">
          {controlError ? "操作未完成" : phaseLabel(snapshot.phase)}
        </p>
        <p className="text-sm tabular-nums text-muted-foreground">
          {formatCaptureElapsed(snapshot.elapsedMs)}
        </p>
      </div>
      {confirmStop ? (
        <div className="no-drag flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmStop(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            autoFocus
            onClick={() => void control("stop")}
          >
            确认停止
          </Button>
        </div>
      ) : (
        <div className="no-drag flex items-center gap-1">
          {canPause ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="暂停录制"
              disabled={pending}
              onClick={() => void control("pause")}
            >
              <CirclePause aria-hidden="true" />
            </Button>
          ) : null}
          {canResume ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="继续录制"
              disabled={pending}
              onClick={() => void control("resume")}
            >
              <Play aria-hidden="true" />
            </Button>
          ) : null}
          {canStop ? (
            <Button
              size="icon-sm"
              variant="destructive"
              aria-label="停止并保存"
              disabled={pending}
              onClick={() => setConfirmStop(true)}
            >
              <Square aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="打开录制详情"
            onClick={() =>
              void window.voice2textFloating.windowAction("open-details")
            }
          >
            <ExternalLink aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="隐藏本次录制的悬浮控制"
            onClick={() => void window.voice2textFloating.windowAction("hide")}
          >
            <X aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭桌面悬浮控制"
            onClick={() =>
              void window.voice2textFloating.windowAction("turn-off")
            }
          >
            <Power aria-hidden="true" />
          </Button>
        </div>
      )}
    </main>
  );
}

function phaseLabel(phase: FloatingCaptureSnapshot["phase"]): string {
  return {
    idle: "待机",
    recording: "正在录制",
    paused: "录制已暂停",
    finalizing: "正在保存",
    attention: "录制需要处理",
  }[phase];
}
