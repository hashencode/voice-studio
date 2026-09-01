import * as React from "react";
import {
  CheckCircle2,
  CirclePause,
  Mic,
  Play,
  Square,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CaptionWorkspace } from "@/features/captions/caption-workspace";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import {
  deriveCaptureCompactPresentation,
  formatCaptureElapsed,
  type CaptureCompactAction,
  type CaptureView,
} from "./capture-presentation";
import {
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "./use-recording-preference";

type CaptureControlAction = CaptureCompactAction;

let commandSequence = 0;

export function CaptureWorkspace({
  capture,
  recordRequest,
  detailOpen = true,
  focusSessionId = null,
  autoOpenRecoveries = false,
  onPreflightResolved,
  onDetailOpenChange,
  onOpenLocalModels,
}: {
  capture: ApplicationSnapshot["capture"];
  /** @deprecated Capture state is authoritative in Main and arrives via snapshots. */
  applicationRevision?: number;
  recordRequest?: number;
  detailOpen?: boolean;
  focusSessionId?: string | null;
  preferredMicrophoneDeviceId?: string | null;
  autoOpenRecoveries?: boolean;
  onPreflightResolved?: (preflight: CapturePreflight) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenLocalModels?: () => void;
}) {
  const [preflight, setPreflight] = React.useState<CapturePreflight | null>(
    null,
  );
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [title, setTitle] = React.useState("音频录制");
  const [captionEnabled, setCaptionEnabled] = React.useState(true);
  const [microphoneDeviceId, setMicrophoneDeviceId] = React.useState("");
  const [recoveries, setRecoveries] = React.useState<CaptureSnapshot[]>([]);
  const [loadedRecoveryTarget, setLoadedRecoveryTarget] = React.useState<
    string | null
  >(null);
  const [managementOpen, setManagementOpen] = React.useState(false);
  const [dismissedSessionId, setDismissedSessionId] = React.useState<
    string | null
  >(null);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [operationMessage, setOperationMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [stopConfirmationSessionId, setStopConfirmationSessionId] =
    React.useState<string | null>(null);
  const [successfulTerminalStopSessionId, setSuccessfulTerminalStopSessionId] =
    React.useState<string | null>(null);
  const pendingRef = React.useRef(new Set<string>());
  const terminalActionRef = React.useRef<HTMLButtonElement>(null);
  const focusedTerminalStopSessionRef = React.useRef<string | null>(null);
  const lastRecordRequestRef = React.useRef(recordRequest ?? 0);
  const recoverySessionId =
    capture.phase === "recovery" ? capture.sessionId : null;
  const prioritizedRecoverySessionId = focusSessionId ?? recoverySessionId;
  const recordingPreference = useRecordingPreference();

  React.useEffect(() => {
    let active = true;
    const loadTarget = prioritizedRecoverySessionId ?? "all";
    void window.voice2text
      .listCaptureRecoveries()
      .then((values) => {
        if (!active) return;
        setError(null);
        setRecoveries(
          prioritizedRecoverySessionId
            ? [...values].sort((left, right) =>
                left.sessionId === prioritizedRecoverySessionId
                  ? -1
                  : right.sessionId === prioritizedRecoverySessionId
                    ? 1
                    : 0,
              )
            : values,
        );
        if (
          autoOpenRecoveries &&
          values.length > 0 &&
          !prioritizedRecoverySessionId
        ) {
          onDetailOpenChange?.(true);
        }
        setLoadedRecoveryTarget(loadTarget);
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadedRecoveryTarget(loadTarget);
          setError(userFacingError(reason, "无法检查可恢复录制"));
        }
      });
    return () => {
      active = false;
    };
  }, [autoOpenRecoveries, onDetailOpenChange, prioritizedRecoverySessionId]);

  const captureCandidate = capture.phase === "idle" ? null : capture;
  const activeCapture =
    captureCandidate?.sessionId === dismissedSessionId
      ? null
      : captureCandidate;
  const stopConfirmationOpen = Boolean(
    activeCapture &&
    activeCapture.sessionId === stopConfirmationSessionId &&
    activeCapture.sessionId !== successfulTerminalStopSessionId &&
    !["completed", "failed", "recovery"].includes(activeCapture.phase),
  );

  React.useEffect(() => {
    if (!successfulTerminalStopSessionId) return;
    if (
      !activeCapture ||
      activeCapture.sessionId !== successfulTerminalStopSessionId
    )
      return;
    if (!canBeginAnotherCapture(activeCapture) || pendingAction !== null)
      return;
    if (
      focusedTerminalStopSessionRef.current === successfulTerminalStopSessionId
    )
      return;
    terminalActionRef.current?.focus();
    focusedTerminalStopSessionRef.current = successfulTerminalStopSessionId;
  }, [activeCapture, pendingAction, successfulTerminalStopSessionId]);

  const runExclusive = React.useCallback(
    async (identity: string, label: string, operation: () => Promise<void>) => {
      if (pendingRef.current.has(identity)) return;
      pendingRef.current.add(identity);
      setPendingAction(identity);
      setOperationMessage(label);
      setError(null);
      try {
        await operation();
      } catch (reason: unknown) {
        setError(userFacingError(reason, "录制操作未完成"));
      } finally {
        pendingRef.current.delete(identity);
        setPendingAction((current) => (current === identity ? null : current));
      }
    },
    [],
  );

  const checkPreflight = React.useCallback(() => {
    void runExclusive("preflight", "正在检查录制条件", async () => {
      const result = await window.voice2text.preflightCapture({
        requestPermissions: true,
        captionEnabled,
      });
      setPreflight(result);
      onPreflightResolved?.(result);
      if (!result.captionModelAvailable) setCaptionEnabled(false);
      const defaultMicrophone = resolveRecordingMicrophone(
        result.microphones,
        recordingPreference.microphoneDeviceId,
      );
      setMicrophoneDeviceId(defaultMicrophone?.id ?? "");
      if (!result.canStart || !defaultMicrophone) {
        setSetupOpen(false);
        setOperationMessage("录制条件已变化");
        return;
      }
      setSetupOpen(true);
      onDetailOpenChange?.(true);
      setOperationMessage("录制设置已打开");
    });
  }, [
    captionEnabled,
    onDetailOpenChange,
    onPreflightResolved,
    recordingPreference.microphoneDeviceId,
    runExclusive,
  ]);

  React.useEffect(() => {
    if (
      recordRequest === undefined ||
      recordRequest <= lastRecordRequestRef.current
    ) {
      return;
    }
    lastRecordRequestRef.current = recordRequest;
    if (!activeCapture || canBeginAnotherCapture(activeCapture)) {
      void Promise.resolve().then(() => {
        if (activeCapture) setDismissedSessionId(activeCapture.sessionId);
        setPreflight(null);
        setSetupOpen(false);
        setError(null);
        checkPreflight();
      });
    }
  }, [activeCapture, checkPreflight, recordRequest]);

  const start = React.useCallback(() => {
    if (
      !preflight?.canStart ||
      (captionEnabled && !preflight.captionModelAvailable) ||
      !title.trim()
    )
      return;
    void runExclusive("start", "正在开始录制", async () => {
      await window.voice2text.startCapture({
        title: title.trim(),
        microphoneDeviceId: microphoneDeviceId || undefined,
        captionEnabled,
        idempotencyKey: commandKey("start"),
      });
      setDismissedSessionId(null);
      setSetupOpen(false);
      setOperationMessage("录制已经开始");
    });
  }, [captionEnabled, microphoneDeviceId, preflight, runExclusive, title]);

  const control = React.useCallback(
    (action: CaptureControlAction) => {
      if (
        !activeCapture ||
        (action === "stop" &&
          activeCapture.sessionId === successfulTerminalStopSessionId)
      )
        return;
      const operationLabel = {
        pause: "正在暂停录制",
        resume: "正在继续录制",
        stop: "正在安全结束录制",
      }[action];
      void runExclusive(
        `control-${activeCapture.sessionId}`,
        operationLabel,
        async () => {
          const result = await window.voice2text.controlCapture({
            action,
            sessionId: activeCapture.sessionId,
            idempotencyKey: commandKey(action),
          });
          setOperationMessage(
            capturePhaseLabel(
              toApplicationPhase(result.state),
              result.interruptionReason,
            ),
          );
          if (action === "stop" && isTerminalStopResult(result)) {
            focusedTerminalStopSessionRef.current = null;
            setSuccessfulTerminalStopSessionId(result.sessionId);
            setStopConfirmationSessionId(null);
          }
        },
      );
    },
    [activeCapture, runExclusive, successfulTerminalStopSessionId],
  );

  const requestControl = React.useCallback(
    (action: CaptureControlAction) => {
      if (action === "stop") {
        if (
          activeCapture &&
          activeCapture.sessionId !== successfulTerminalStopSessionId
        ) {
          setStopConfirmationSessionId(activeCapture.sessionId);
        }
        return;
      }
      control(action);
    },
    [activeCapture, control, successfulTerminalStopSessionId],
  );

  const confirmStop = React.useCallback(() => {
    control("stop");
  }, [control]);

  const recover = React.useCallback(
    (item: CaptureSnapshot, action: "keep" | "discard") => {
      void runExclusive(
        `recovery-${item.sessionId}`,
        action === "keep" ? "正在保留恢复录制" : "正在丢弃恢复录制",
        async () => {
          await window.voice2text.actOnCaptureRecovery({
            action,
            sessionId: item.sessionId,
            idempotencyKey: commandKey(action),
          });
          setRecoveries((current) =>
            current.filter(
              (candidate) => candidate.sessionId !== item.sessionId,
            ),
          );
          setOperationMessage(
            action === "keep" ? "恢复录制已保留" : "恢复录制已丢弃",
          );
        },
      );
    },
    [runExclusive],
  );

  const busy = pendingAction !== null;
  const beginAnotherCapture = React.useCallback(() => {
    if (!activeCapture) return;
    setDismissedSessionId(activeCapture.sessionId);
    setPreflight(null);
    setSetupOpen(false);
    setError(null);
    checkPreflight();
  }, [activeCapture, checkPreflight]);

  const focusedRecoveries = focusSessionId
    ? recoveries.filter((item) => item.sessionId === focusSessionId)
    : recoveries;
  const focusedActiveCapture =
    !focusSessionId || activeCapture?.sessionId === focusSessionId
      ? activeCapture
      : null;
  const focusedCaptureUnavailable =
    Boolean(focusSessionId) &&
    loadedRecoveryTarget === focusSessionId &&
    focusedRecoveries.length === 0 &&
    !focusedActiveCapture;
  if (
    recordRequest !== undefined &&
    !activeCapture &&
    !setupOpen &&
    recoveries.length === 0 &&
    !focusSessionId
  ) {
    return null;
  }

  const detail = detailOpen ? (
    <section
      role="region"
      aria-label="录制详情"
      aria-busy={busy}
      className="mx-auto w-full max-w-3xl space-y-5"
    >
      {busy ? (
        <p className="mb-3 border-b bg-muted/40 pb-3 text-sm font-medium">
          {operationMessage}
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mb-3 border-y border-destructive/40 bg-destructive/5 py-3 text-sm"
        >
          {error}
        </div>
      ) : null}

      {focusedRecoveries.length > 0 ? (
        <RecoverySurface
          items={focusedRecoveries}
          busy={busy}
          managementOpen={managementOpen}
          onManage={() => setManagementOpen(true)}
          onAction={recover}
        />
      ) : null}

      {focusedCaptureUnavailable ? (
        <section role="status" className="border-y py-6 text-sm">
          <p className="font-medium">这条录制已不在待恢复列表中</p>
          <p className="mt-1 text-muted-foreground">
            消息记录仍会保留，但不会用当前录制替代它。
          </p>
        </section>
      ) : focusedActiveCapture ? (
        <ActiveCapture
          capture={focusedActiveCapture}
          busy={busy}
          pendingAction={pendingAction}
          stopConfirmationOpen={stopConfirmationOpen}
          stopSubmitted={
            focusedActiveCapture.sessionId === successfulTerminalStopSessionId
          }
          terminalActionRef={terminalActionRef}
          onCancelStop={() => setStopConfirmationSessionId(null)}
          onConfirmStop={confirmStop}
          onControl={requestControl}
          onBeginAnother={beginAnotherCapture}
        />
      ) : !focusSessionId ? (
        <CaptureSetup
          setupOpen={setupOpen}
          preflight={preflight}
          title={title}
          busy={busy}
          onCheck={checkPreflight}
          onStart={start}
          onTitleChange={setTitle}
          captionAvailable={preflight?.captionModelAvailable ?? true}
          captionEnabled={captionEnabled}
          onOpenLocalModels={onOpenLocalModels}
        />
      ) : null}
    </section>
  ) : null;

  return detail;
}

export function FloatingCapturePreferenceSetting({
  className = "",
  api = window.voice2text,
}: {
  className?: string;
  api?: Voice2TextDesktopApi;
}) {
  const [enabled, setEnabled] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void api
      .getFloatingCapturePreference?.()
      .then((preference) => {
        if (active) setEnabled(preference.enabled);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (!api.setFloatingCapturePreference) return null;
  return (
    <Field orientation="horizontal" className={`items-center! ${className}`}>
      <FieldContent>
        <FieldLabel asChild>
          <div id="floating-capture-label">悬浮控制条</div>
        </FieldLabel>
        <FieldDescription>
          录制音频时在桌面右上角显示状态和控件
        </FieldDescription>
        {error ? <FieldError>设置未保存，请重试。</FieldError> : null}
      </FieldContent>
      <Switch
        id="floating-capture-enabled"
        aria-labelledby="floating-capture-label"
        checked={enabled}
        disabled={pending}
        onCheckedChange={(value) => {
          const previous = enabled;
          setEnabled(value);
          setPending(true);
          setError(false);
          void api
            .setFloatingCapturePreference?.(value)
            .then((preference) => setEnabled(preference.enabled))
            .catch(() => {
              setEnabled(previous);
              setError(true);
            })
            .finally(() => setPending(false));
        }}
      />
    </Field>
  );
}

function CaptureSetup({
  setupOpen,
  preflight,
  title,
  busy,
  onCheck,
  onStart,
  onTitleChange,
  captionAvailable,
  captionEnabled,
  onOpenLocalModels,
}: {
  setupOpen: boolean;
  preflight: CapturePreflight | null;
  title: string;
  busy: boolean;
  onCheck: () => void;
  onStart: () => void;
  onTitleChange: (value: string) => void;
  captionAvailable: boolean;
  captionEnabled: boolean;
  onOpenLocalModels?: () => void;
}) {
  if (!setupOpen) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Mic className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">音频录制</h2>
          <p className="text-sm text-muted-foreground">
            跨页面持续运行，由本机安全保存。
          </p>
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={onCheck}>
          检查并设置录制
        </Button>
      </div>
    );
  }

  const readyToStart = Boolean(preflight?.canStart);
  return (
    <section aria-labelledby="capture-setup-heading" className="space-y-3">
      <h2 id="capture-setup-heading" className="font-semibold">
        设置音频录制
      </h2>
      <div className="space-y-1.5">
        <Label htmlFor="capture-title">录制名称</Label>
        <Input
          id="capture-title"
          value={title}
          maxLength={256}
          disabled={busy}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm text-muted-foreground">
          {captionEnabled && captionAvailable
            ? "实时字幕已启用。"
            : "实时字幕模型未安装，本次仍可正常录音。"}
        </p>
        {!captionAvailable && onOpenLocalModels ? (
          <Button type="button" variant="outline" onClick={onOpenLocalModels}>
            前往本地模型
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {readyToStart ? (
          <Button
            type="button"
            disabled={busy || !title.trim()}
            onClick={onStart}
          >
            <Mic aria-hidden="true" />
            {busy ? "正在开始…" : "开始录制"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ActiveCapture({
  capture,
  busy,
  pendingAction,
  stopConfirmationOpen,
  stopSubmitted,
  terminalActionRef,
  onCancelStop,
  onConfirmStop,
  onControl,
  onBeginAnother,
}: {
  capture: CaptureView;
  busy: boolean;
  pendingAction: string | null;
  stopConfirmationOpen: boolean;
  stopSubmitted: boolean;
  terminalActionRef: React.RefObject<HTMLButtonElement | null>;
  onCancelStop: () => void;
  onConfirmStop: () => void;
  onControl: (action: CaptureControlAction) => void;
  onBeginAnother: () => void;
}) {
  const presentation = deriveCaptureCompactPresentation(capture);
  const paused = presentation?.action === "resume";
  const wakeRequiresResume =
    paused && capture.interruptionReason === "system_wake_requires_resume";
  const running = presentation?.action === "pause";
  const finalizedPartial = capture.phase === "partial_capture" && !running;
  const label = finalizedPartial
    ? "部分录制已安全保存"
    : capturePhaseLabel(capture.phase, capture.interruptionReason);
  return (
    <section aria-label="当前录制" className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          {paused ? (
            <CirclePause className="size-5" aria-hidden="true" />
          ) : (
            <Mic className="size-5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <h2 className="truncate font-semibold">{capture.title}</h2>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {formatCaptureElapsed(capture.elapsedMs)} · 切换页面不会停止此会话
          </p>
          {capture.message ? (
            <p className="mt-2 text-sm">{capture.message}</p>
          ) : null}
        </div>
      </div>
      {capture.phase === "partial_capture" || capture.partialCapture ? (
        <PartialCaptureStatus capture={capture} />
      ) : null}
      <ActiveCaptionWorkspace sessionId={capture.sessionId} />
      {pendingAction?.startsWith("control-") ? (
        <p className="text-sm font-medium">
          {capture.phase === "finalizing" ? "正在安全结束录制" : "操作处理中…"}
        </p>
      ) : null}
      {presentation?.canStop ? (
        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onControl("pause")}
            >
              <CirclePause aria-hidden="true" />
              暂停录制
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={() => onControl("resume")}
            >
              <Play aria-hidden="true" />
              {wakeRequiresResume ? "确认并继续录制" : "继续录制"}
            </Button>
          )}
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
                variant="destructive"
                disabled={busy || stopSubmitted}
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
        </div>
      ) : capture.phase === "completed" ||
        capture.phase === "failed" ||
        finalizedPartial ? (
        <div className="flex justify-end">
          <Button
            ref={terminalActionRef}
            type="button"
            disabled={busy}
            onClick={onBeginAnother}
          >
            <Mic aria-hidden="true" />
            {capture.phase === "completed" || finalizedPartial
              ? "录制另一个音频"
              : "重新设置录制"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function canBeginAnotherCapture(capture: CaptureView): boolean {
  return (
    capture.phase === "completed" ||
    capture.phase === "failed" ||
    (capture.phase === "partial_capture" &&
      !capture.systemAudioHealthy &&
      !capture.microphoneHealthy)
  );
}

function isTerminalStopResult(capture: CaptureSnapshot): boolean {
  return (
    capture.state === "completed" ||
    capture.state === "failed" ||
    (capture.state === "partial_capture" &&
      !capture.systemAudioHealthy &&
      !capture.microphoneHealthy)
  );
}

function ActiveCaptionWorkspace({ sessionId }: { sessionId: string }) {
  return (
    <CaptionWorkspace
      sessionId={sessionId}
      getSnapshot={window.voice2text.getCaptionSnapshot}
      subscribe={window.voice2text.onCaptionSnapshot}
      retryFormal={window.voice2text.retryFormalTranscript}
    />
  );
}

function PartialCaptureStatus({ capture }: { capture: CaptureView }) {
  const failedTracks = [
    capture.systemAudioHealthy === false ? "系统音频轨道已中断" : null,
    capture.microphoneHealthy === false ? "麦克风轨道已中断" : null,
  ].filter(Boolean);
  const healthyTrack = capture.systemAudioHealthy
    ? "系统音频轨道仍在安全录制"
    : capture.microphoneHealthy
      ? "麦克风轨道仍在安全录制"
      : "当前没有健康录音轨道";
  return (
    <div
      role="alert"
      className="border-y border-amber-500/40 bg-amber-500/5 py-3 text-sm"
    >
      <p className="font-medium">
        部分录制：{failedTracks.join("，") || "轨道状态异常"}
      </p>
      <p className="mt-1">{healthyTrack}</p>
      <p className="mt-1">
        时间轴已标记 {capture.gapCount ?? 0} 个时间缺口，现有音频会被保留。
      </p>
    </div>
  );
}

function RecoverySurface({
  items,
  busy,
  managementOpen,
  onManage,
  onAction,
}: {
  items: CaptureSnapshot[];
  busy: boolean;
  managementOpen: boolean;
  onManage: () => void;
  onAction: (item: CaptureSnapshot, action: "keep" | "discard") => void;
}) {
  return (
    <section
      aria-labelledby="capture-recovery-heading"
      className="mb-4 space-y-3 border-b pb-4"
    >
      <div>
        <p className="text-xs font-medium text-amber-700">需要你确认</p>
        <h2 id="capture-recovery-heading" className="font-semibold">
          发现可恢复录制
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          应用关闭或重新载入不会删除已保存的录音。
        </p>
      </div>
      <div className="divide-y border-y">
        {items.map((item) => (
          <div key={item.sessionId} className="py-3 text-sm">
            <p className="font-medium">中断的音频录制</p>
            <p className="mt-1 text-muted-foreground">
              {formatCaptureElapsed(item.captureTimelineMs)} · {item.gapCount}{" "}
              个时间缺口
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {!managementOpen ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={onManage}
                >
                  管理恢复录制
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => onAction(item, "discard")}
                >
                  <Trash2 aria-hidden="true" />
                  丢弃这段恢复录制
                </Button>
              )}
              <Button
                type="button"
                disabled={busy}
                onClick={() => onAction(item, "keep")}
              >
                <CheckCircle2 aria-hidden="true" />
                保留并完成恢复
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function toApplicationPhase(
  state: CaptureSnapshot["state"],
): CaptureView["phase"] {
  return state === "recoverable" ? "recovery" : state;
}

function capturePhaseLabel(
  phase: CaptureView["phase"],
  interruptionReason?: string | null,
): string {
  if (
    phase === "paused" &&
    interruptionReason === "system_wake_requires_resume"
  ) {
    return "等待你确认继续录制";
  }
  if (phase === "paused" && interruptionReason === "system_sleep") {
    return "电脑睡眠，录制已暂停";
  }
  return {
    preflight: "正在检查录制条件",
    preparing: "正在准备录制",
    recording: "正在录制",
    paused: "录制已暂停",
    finalizing: "正在安全结束录制",
    completed: "录制已完成",
    recovery: "录制等待恢复",
    partial_capture: "部分轨道录制中",
    failed: "录制需要处理",
  }[phase];
}

function commandKey(action: string): string {
  commandSequence += 1;
  return `${action}-renderer-${Date.now()}-${commandSequence}`;
}
