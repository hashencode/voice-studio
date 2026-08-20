import * as React from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Mic2,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CaptionWorkspace } from "@/features/captions/caption-workspace";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureSnapshot,
} from "@shared/contracts";
import {
  deriveCaptureCompactPresentation,
  formatCaptureElapsed,
  type CaptureCompactAction,
  type CaptureView,
} from "./capture-presentation";

type CaptureControlAction = CaptureCompactAction;

let commandSequence = 0;

export function CaptureWorkspace({
  capture,
  recordRequest,
  detailOpen = true,
  focusSessionId = null,
  compactHost = null,
  onDetailOpenChange,
  onAttentionDetailsOpened,
}: {
  capture: ApplicationSnapshot["capture"];
  /** @deprecated Capture state is authoritative in Main and arrives via snapshots. */
  applicationRevision?: number;
  recordRequest?: number;
  detailOpen?: boolean;
  focusSessionId?: string | null;
  compactHost?: HTMLElement | null;
  onDetailOpenChange?: (open: boolean) => void;
  onAttentionDetailsOpened?: (sessionId: string) => void;
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
  const [dismissedCompactSessionId, setDismissedCompactSessionId] =
    React.useState<string | null>(null);
  const pendingRef = React.useRef(new Set<string>());
  const preflightAlertRef = React.useRef<HTMLDivElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLInputElement>(null);
  const lastRecordRequestRef = React.useRef(recordRequest ?? 0);
  const recoverySessionId =
    capture.phase === "recovery" ? capture.sessionId : null;
  const prioritizedRecoverySessionId = focusSessionId ?? recoverySessionId;

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
        setLoadedRecoveryTarget(loadTarget);
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadedRecoveryTarget(loadTarget);
          setError(errorMessage(reason, "无法检查可恢复录制"));
        }
      });
    return () => {
      active = false;
    };
  }, [prioritizedRecoverySessionId]);

  React.useEffect(() => {
    if (preflight && preflight.blockingReasons.length > 0) {
      preflightAlertRef.current?.focus();
    }
  }, [preflight]);

  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  React.useEffect(() => {
    if (preflight?.canStart && setupOpen) titleRef.current?.focus();
  }, [preflight, setupOpen]);

  const captureCandidate = capture.phase === "idle" ? null : capture;
  const activeCapture =
    captureCandidate?.sessionId === dismissedSessionId
      ? null
      : captureCandidate;
  const stopConfirmationOpen = Boolean(
    activeCapture &&
    activeCapture.sessionId === stopConfirmationSessionId &&
    !["completed", "failed", "recovery"].includes(activeCapture.phase),
  );

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
        setError(errorMessage(reason, "录制操作未完成"));
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
      setSetupOpen(true);
      onDetailOpenChange?.(true);
      const defaultMicrophone =
        result.microphones.find((device) => device.isDefault) ??
        result.microphones[0];
      setMicrophoneDeviceId(defaultMicrophone?.id ?? "");
      setOperationMessage(
        result.canStart && !(captionEnabled && !result.captionModelAvailable)
          ? "录制条件检查完成"
          : "录制条件需要处理",
      );
    });
  }, [captionEnabled, onDetailOpenChange, runExclusive]);

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
      if (!activeCapture) return;
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
        },
      );
    },
    [activeCapture, runExclusive],
  );

  const requestControl = React.useCallback(
    (action: CaptureControlAction) => {
      if (action === "stop") {
        if (activeCapture) {
          setStopConfirmationSessionId(activeCapture.sessionId);
        }
        return;
      }
      control(action);
    },
    [activeCapture, control],
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
  const recoveryCapture = focusedRecoveries[0];
  const focusedActiveCapture =
    !focusSessionId || activeCapture?.sessionId === focusSessionId
      ? activeCapture
      : null;
  const focusedCaptureUnavailable =
    Boolean(focusSessionId) &&
    loadedRecoveryTarget === focusSessionId &&
    focusedRecoveries.length === 0 &&
    !focusedActiveCapture;
  const compactPresentation = deriveCaptureCompactPresentation(
    activeCapture ??
      (recoveryCapture
        ? {
            phase: "recovery",
            sessionId: recoveryCapture.sessionId,
            title: "恢复的音频录制",
            elapsedMs: recoveryCapture.captureTimelineMs,
          }
        : { phase: "idle" }),
  );

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
      {onDetailOpenChange ? (
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <p className="text-sm font-medium text-muted-foreground">本机录制</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onDetailOpenChange(false)}
          >
            <X aria-hidden="true" />
            返回
          </Button>
        </div>
      ) : null}
      <p
        role="status"
        aria-label="录制操作状态"
        aria-live="polite"
        className={
          busy
            ? "mb-3 border-b bg-muted/40 pb-3 text-sm font-medium"
            : "sr-only"
        }
      >
        {operationMessage}
      </p>
      {error ? (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="mb-3 border-y border-destructive/40 bg-destructive/5 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          captionEnabled={captionEnabled}
          microphoneDeviceId={microphoneDeviceId}
          busy={busy}
          titleRef={titleRef}
          alertRef={preflightAlertRef}
          onCheck={checkPreflight}
          onStart={start}
          onTitleChange={setTitle}
          onCaptionChange={(value) => {
            setCaptionEnabled(value);
            setPreflight(null);
          }}
          onMicrophoneChange={setMicrophoneDeviceId}
        />
      ) : null}
      <FloatingCapturePreferenceSetting className="border-t pt-4" />
    </section>
  ) : null;

  const compact =
    compactHost &&
    compactPresentation &&
    compactPresentation.sessionId !== dismissedCompactSessionId
      ? createPortal(
          <CompactCaptureController
            presentation={compactPresentation}
            busy={busy}
            stopConfirmationOpen={stopConfirmationOpen}
            onControl={requestControl}
            onConfirmStop={confirmStop}
            onCancelStop={() => setStopConfirmationSessionId(null)}
            onOpenDetails={() => {
              if (compactPresentation.needsAttention) {
                setDismissedCompactSessionId(compactPresentation.sessionId);
                onAttentionDetailsOpened?.(compactPresentation.sessionId);
              }
              onDetailOpenChange?.(true);
            }}
            onDismiss={() =>
              setDismissedCompactSessionId(compactPresentation.sessionId)
            }
          />,
          compactHost,
        )
      : null;

  return (
    <>
      {detail}
      {compact}
    </>
  );
}

export function FloatingCapturePreferenceSetting({
  className = "",
}: {
  className?: string;
}) {
  const [enabled, setEnabled] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void window.voice2text
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
  }, []);
  if (!window.voice2text.setFloatingCapturePreference) return null;
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div>
        <Label htmlFor="floating-capture-enabled">录制时显示桌面悬浮控制</Label>
        <p className="mt-1 text-sm text-muted-foreground">
          切换到其他应用或最小化后，在桌面右上角显示精简状态与控制。
        </p>
        {error ? (
          <p className="mt-1 text-sm text-destructive" role="alert">
            设置未保存，请重试。
          </p>
        ) : null}
      </div>
      <Switch
        id="floating-capture-enabled"
        checked={enabled}
        disabled={pending}
        onCheckedChange={(value) => {
          const previous = enabled;
          setEnabled(value);
          setPending(true);
          setError(false);
          void window.voice2text
            .setFloatingCapturePreference?.(value)
            .then((preference) => setEnabled(preference.enabled))
            .catch(() => {
              setEnabled(previous);
              setError(true);
            })
            .finally(() => setPending(false));
        }}
      />
    </div>
  );
}

function CaptureSetup({
  setupOpen,
  preflight,
  title,
  captionEnabled,
  microphoneDeviceId,
  busy,
  titleRef,
  alertRef,
  onCheck,
  onStart,
  onTitleChange,
  onCaptionChange,
  onMicrophoneChange,
}: {
  setupOpen: boolean;
  preflight: CapturePreflight | null;
  title: string;
  captionEnabled: boolean;
  microphoneDeviceId: string;
  busy: boolean;
  titleRef: React.RefObject<HTMLInputElement | null>;
  alertRef: React.RefObject<HTMLDivElement | null>;
  onCheck: () => void;
  onStart: () => void;
  onTitleChange: (value: string) => void;
  onCaptionChange: (value: boolean) => void;
  onMicrophoneChange: (value: string) => void;
}) {
  if (!setupOpen) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Mic2 className="size-5" aria-hidden="true" />
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

  const blockers = preflight?.blockingReasons ?? [];
  const captionsUnavailable = Boolean(
    preflight && captionEnabled && !preflight.captionModelAvailable,
  );
  const readyToStart = Boolean(preflight?.canStart && !captionsUnavailable);
  return (
    <section aria-labelledby="capture-setup-heading" className="space-y-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground">本机录制</p>
        <h2 id="capture-setup-heading" className="font-semibold">
          设置音频录制
        </h2>
      </div>
      {preflight && blockers.length > 0 ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="border-y border-amber-500/40 bg-amber-500/5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex gap-2">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">录制条件需要处理</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                {blockers.map((reason) => (
                  <li key={reason}>{preflightReason(reason)}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
      {readyToStart ? (
        <div className="border-y bg-muted/30 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2
              className="size-4 text-emerald-600"
              aria-hidden="true"
            />
            {blockers.length > 0 ? "可使用降级录制" : "录制条件已就绪"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {preflight?.captureMode === "dual_track"
              ? "系统音频与麦克风将分别保存。"
              : "当前将仅保存麦克风轨道。"}
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="capture-title">录制名称</Label>
        <Input
          ref={titleRef}
          id="capture-title"
          value={title}
          maxLength={256}
          disabled={busy}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="capture-microphone">麦克风</Label>
        <Select
          value={microphoneDeviceId || undefined}
          disabled={busy || !preflight?.microphones.length}
          onValueChange={onMicrophoneChange}
        >
          <SelectTrigger id="capture-microphone" className="w-full">
            <SelectValue placeholder="没有可用设备" />
          </SelectTrigger>
          <SelectContent>
            {preflight?.microphones.map((device) => (
              <SelectItem key={device.id} value={device.id}>
                {device.name}
                {device.isDefault ? "（默认）" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-start gap-2">
        <Switch
          id="capture-caption-enabled"
          checked={captionEnabled}
          disabled={busy}
          onCheckedChange={onCaptionChange}
          className="mt-0.5"
        />
        <Label htmlFor="capture-caption-enabled" className="leading-5">
          同时生成本机字幕（模型不可用时可关闭后重新检查）
        </Label>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCheck}
        >
          <RotateCcw aria-hidden="true" />
          重新检查录制条件
        </Button>
        {readyToStart ? (
          <Button
            type="button"
            disabled={busy || !title.trim()}
            onClick={onStart}
          >
            <Mic2 aria-hidden="true" />
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
  onCancelStop,
  onConfirmStop,
  onControl,
  onBeginAnother,
}: {
  capture: CaptureView;
  busy: boolean;
  pendingAction: string | null;
  stopConfirmationOpen: boolean;
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
      <div
        role="status"
        aria-label="录制状态"
        aria-live="polite"
        className="flex items-start gap-3"
      >
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
          {stopConfirmationOpen ? (
            <StopConfirmation
              busy={busy}
              onCancel={onCancelStop}
              onConfirm={onConfirmStop}
            />
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => onControl("stop")}
            >
              <Square aria-hidden="true" />
              停止并保存
            </Button>
          )}
        </div>
      ) : capture.phase === "completed" ||
        capture.phase === "failed" ||
        finalizedPartial ? (
        <div className="flex justify-end">
          <Button type="button" disabled={busy} onClick={onBeginAnother}>
            <Mic2 aria-hidden="true" />
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

function CompactCaptureController({
  presentation,
  busy,
  stopConfirmationOpen,
  onControl,
  onConfirmStop,
  onCancelStop,
  onOpenDetails,
  onDismiss,
}: {
  presentation: NonNullable<
    ReturnType<typeof deriveCaptureCompactPresentation>
  >;
  busy: boolean;
  stopConfirmationOpen: boolean;
  onControl: (action: CaptureControlAction) => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
  onOpenDetails: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="complementary"
      aria-label="录制控制"
      aria-busy={busy}
      className="ml-auto flex min-w-0 items-center gap-1.5 rounded-lg border bg-background px-2 py-1"
    >
      <span
        className="size-2 shrink-0 rounded-full bg-destructive"
        aria-hidden="true"
      />
      <span className="hidden text-xs font-medium sm:inline">
        {presentation.status}
      </span>
      <span className="min-w-12 text-xs font-medium tabular-nums">
        {presentation.elapsed}
      </span>
      {presentation.indicator ? (
        <span className="hidden text-xs text-amber-700 lg:inline">
          {presentation.indicator}
        </span>
      ) : null}
      {stopConfirmationOpen && presentation.phase === "finalizing" ? (
        <span className="text-xs font-medium">正在安全保存…</span>
      ) : presentation.needsAttention ? (
        <>
          <span className="text-xs font-medium text-amber-700">需要处理</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenDetails}
          >
            打开详情
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            忽略
          </Button>
        </>
      ) : (
        <>
          {presentation.action ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={
                presentation.action === "pause" ? "暂停录制" : "继续录制"
              }
              onClick={() => onControl(presentation.action!)}
            >
              {presentation.action === "pause" ? (
                <CirclePause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              <span className="hidden xl:inline">
                {presentation.action === "pause" ? "暂停" : "继续"}
              </span>
            </Button>
          ) : null}
          {presentation.canStop ? (
            stopConfirmationOpen ? (
              <StopConfirmation
                compact
                busy={busy}
                onCancel={onCancelStop}
                onConfirm={onConfirmStop}
              />
            ) : (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                aria-label="停止并保存"
                onClick={() => onControl("stop")}
              >
                <Square aria-hidden="true" />
                <span className="hidden xl:inline">停止</span>
              </Button>
            )
          ) : null}
        </>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="打开录制详情"
        onClick={onOpenDetails}
      >
        <Mic2 aria-hidden="true" />
      </Button>
    </div>
  );
}

function StopConfirmation({
  busy,
  compact = false,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  compact?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <span
      role="group"
      aria-label="确认停止录制"
      className="flex items-center gap-1"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Button
        type="button"
        size={compact ? "sm" : "default"}
        variant="ghost"
        disabled={busy}
        onClick={onCancel}
      >
        取消
      </Button>
      <Button
        ref={confirmRef}
        type="button"
        size={compact ? "sm" : "default"}
        variant="destructive"
        disabled={busy}
        onClick={onConfirm}
      >
        <Square aria-hidden="true" />
        {busy ? "正在保存…" : "确认停止并保存"}
      </Button>
    </span>
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
          Renderer 关闭或重新载入不会删除已完成分块。
        </p>
      </div>
      <div className="divide-y border-y">
        {items.map((item) => (
          <div key={item.sessionId} className="py-3 text-sm">
            <p className="font-medium">中断的音频录制</p>
            <p className="mt-1 text-muted-foreground">
              {formatCaptureElapsed(item.captureTimelineMs)} ·{" "}
              {item.finalizedChunkCount} 个已完成分块 · {item.gapCount}{" "}
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

function preflightReason(reason: string): string {
  return (
    {
      microphone_permission_denied:
        "麦克风权限被拒绝，请在系统设置中允许后重新检查。",
      system_audio_runtime_unsupported:
        "系统音频录制不可用；可在支持的 macOS 上重试。",
      microphone_device_missing: "没有可用的麦克风，请连接设备后重新检查。",
      disk_space_low: "磁盘空间不足，请释放空间后重新检查。",
      caption_model_unavailable: "本机字幕模型不可用，可关闭字幕后重新检查。",
    }[reason] ?? `录制条件未满足：${reason}`
  );
}

function commandKey(action: string): string {
  commandSequence += 1;
  return `${action}-renderer-${Date.now()}-${commandSequence}`;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
