import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Mic2,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CaptionWorkspace } from "@/features/captions/caption-workspace";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureSnapshot,
} from "@shared/contracts";

type CaptureView = Exclude<ApplicationSnapshot["capture"], { phase: "idle" }>;
type CaptureControlAction = "pause" | "resume" | "stop";

let commandSequence = 0;

export function CaptureWorkspace({
  capture,
  applicationRevision,
  recordRequest,
}: {
  capture: ApplicationSnapshot["capture"];
  applicationRevision: number;
  recordRequest?: number;
}) {
  const [preflight, setPreflight] = React.useState<CapturePreflight | null>(
    null,
  );
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [title, setTitle] = React.useState("会议录制");
  const [captionEnabled, setCaptionEnabled] = React.useState(true);
  const [microphoneDeviceId, setMicrophoneDeviceId] = React.useState("");
  const [localCapture, setLocalCapture] = React.useState<{
    value: CaptureView;
    basedOnRevision: number;
  } | null>(null);
  const [recoveries, setRecoveries] = React.useState<CaptureSnapshot[]>([]);
  const [managementOpen, setManagementOpen] = React.useState(false);
  const [dismissedSessionId, setDismissedSessionId] = React.useState<
    string | null
  >(null);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [operationMessage, setOperationMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const pendingRef = React.useRef(new Set<string>());
  const preflightAlertRef = React.useRef<HTMLDivElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLInputElement>(null);
  const lastRecordRequestRef = React.useRef(recordRequest ?? 0);
  const recoverySessionId =
    capture.phase === "recovery" ? capture.sessionId : null;

  React.useEffect(() => {
    let active = true;
    void window.voice2text
      .listCaptureRecoveries()
      .then((values) => {
        if (!active) return;
        setError(null);
        setRecoveries(
          recoverySessionId
            ? [...values].sort((left, right) =>
                left.sessionId === recoverySessionId
                  ? -1
                  : right.sessionId === recoverySessionId
                    ? 1
                    : 0,
              )
            : values,
        );
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, "无法检查可恢复录制"));
      });
    return () => {
      active = false;
    };
  }, [recoverySessionId]);

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

  const captureCandidate =
    localCapture && localCapture.basedOnRevision >= applicationRevision
      ? localCapture.value
      : capture.phase === "idle"
        ? null
        : capture;
  const activeCapture =
    captureCandidate?.sessionId === dismissedSessionId
      ? null
      : captureCandidate;

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
  }, [captionEnabled, runExclusive]);

  React.useEffect(() => {
    if (
      recordRequest === undefined ||
      recordRequest <= lastRecordRequestRef.current
    ) {
      return;
    }
    lastRecordRequestRef.current = recordRequest;
    if (!activeCapture) void Promise.resolve().then(checkPreflight);
  }, [activeCapture, checkPreflight, recordRequest]);

  const start = React.useCallback(() => {
    if (
      !preflight?.canStart ||
      (captionEnabled && !preflight.captionModelAvailable) ||
      !title.trim()
    )
      return;
    void runExclusive("start", "正在开始录制", async () => {
      const result = await window.voice2text.startCapture({
        title: title.trim(),
        microphoneDeviceId: microphoneDeviceId || undefined,
        captionEnabled,
        idempotencyKey: commandKey("start"),
      });
      setLocalCapture({
        value: toCaptureView(result, title.trim()),
        basedOnRevision: applicationRevision,
      });
      setDismissedSessionId(null);
      setSetupOpen(false);
      setOperationMessage("录制已经开始");
    });
  }, [
    captionEnabled,
    microphoneDeviceId,
    preflight,
    runExclusive,
    title,
    applicationRevision,
  ]);

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
          setLocalCapture({
            value: toCaptureView(result, activeCapture.title),
            basedOnRevision: applicationRevision,
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
    [activeCapture, applicationRevision, runExclusive],
  );

  const recover = React.useCallback(
    (item: CaptureSnapshot, action: "keep" | "discard") => {
      void runExclusive(
        `recovery-${item.sessionId}`,
        action === "keep" ? "正在保留恢复录制" : "正在丢弃恢复录制",
        async () => {
          const result = await window.voice2text.actOnCaptureRecovery({
            action,
            sessionId: item.sessionId,
            idempotencyKey: commandKey(action),
          });
          setRecoveries((current) =>
            current.filter(
              (candidate) => candidate.sessionId !== item.sessionId,
            ),
          );
          if (result) {
            setLocalCapture({
              value: toCaptureView(result, "恢复的会议录制"),
              basedOnRevision: applicationRevision,
            });
          }
          setOperationMessage(
            action === "keep" ? "恢复录制已保留" : "恢复录制已丢弃",
          );
        },
      );
    },
    [applicationRevision, runExclusive],
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

  if (
    recordRequest !== undefined &&
    !activeCapture &&
    !setupOpen &&
    recoveries.length === 0
  ) {
    return null;
  }

  return (
    <aside
      role="complementary"
      aria-label="录制工作区"
      aria-busy={busy}
      className="fixed right-5 bottom-5 z-30 max-h-[calc(100vh-2.5rem)] w-[min(26rem,calc(100vw-2.5rem))] overflow-auto rounded-xl border bg-card p-4 shadow-lg"
    >
      <p
        role="status"
        aria-label="录制操作状态"
        aria-live="polite"
        className={
          busy
            ? "mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm font-medium"
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
          className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {error}
        </div>
      ) : null}

      {recoveries.length > 0 ? (
        <RecoverySurface
          items={recoveries}
          busy={busy}
          managementOpen={managementOpen}
          onManage={() => setManagementOpen(true)}
          onAction={recover}
        />
      ) : null}

      {activeCapture ? (
        <ActiveCapture
          capture={activeCapture}
          busy={busy}
          pendingAction={pendingAction}
          onControl={control}
          onBeginAnother={beginAnotherCapture}
        />
      ) : (
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
      )}
    </aside>
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
          <h2 className="font-semibold">会议录制</h2>
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
          设置会议录制
        </h2>
      </div>
      {preflight && blockers.length > 0 ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
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
        <label htmlFor="capture-title" className="text-sm font-medium">
          录制名称
        </label>
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
        <label htmlFor="capture-microphone" className="text-sm font-medium">
          麦克风
        </label>
        <select
          id="capture-microphone"
          value={microphoneDeviceId}
          disabled={busy || !preflight?.microphones.length}
          onChange={(event) => onMicrophoneChange(event.currentTarget.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {preflight?.microphones.length ? null : (
            <option value="">没有可用设备</option>
          )}
          {preflight?.microphones.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
              {device.isDefault ? "（默认）" : ""}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={captionEnabled}
          disabled={busy}
          onChange={(event) => onCaptionChange(event.currentTarget.checked)}
          className="mt-0.5 size-4"
        />
        <span>同时生成本机字幕（模型不可用时可关闭后重新检查）</span>
      </label>
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
  onControl,
  onBeginAnother,
}: {
  capture: CaptureView;
  busy: boolean;
  pendingAction: string | null;
  onControl: (action: CaptureControlAction) => void;
  onBeginAnother: () => void;
}) {
  const paused = capture.phase === "paused";
  const wakeRequiresResume =
    paused && capture.interruptionReason === "system_wake_requires_resume";
  const running =
    capture.phase === "recording" ||
    (capture.phase === "partial_capture" &&
      Boolean(capture.systemAudioHealthy || capture.microphoneHealthy));
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
            {formatElapsed(capture.elapsedMs)} · 切换页面不会停止此会话
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
      {running || paused ? (
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
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => onControl("stop")}
          >
            <Square aria-hidden="true" />
            {busy ? "正在保存…" : "停止并保存"}
          </Button>
        </div>
      ) : capture.phase === "completed" ||
        capture.phase === "failed" ||
        finalizedPartial ? (
        <div className="flex justify-end">
          <Button type="button" disabled={busy} onClick={onBeginAnother}>
            <Mic2 aria-hidden="true" />
            {capture.phase === "completed" || finalizedPartial
              ? "录制另一个会议"
              : "重新设置录制"}
          </Button>
        </div>
      ) : null}
    </section>
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
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
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
      {items.map((item) => (
        <div key={item.sessionId} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">中断的会议录制</p>
          <p className="mt-1 text-muted-foreground">
            {formatElapsed(item.captureTimelineMs)} · {item.finalizedChunkCount}{" "}
            个已完成分块 · {item.gapCount} 个时间缺口
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
    </section>
  );
}

function toCaptureView(snapshot: CaptureSnapshot, title: string): CaptureView {
  return {
    phase: toApplicationPhase(snapshot.state),
    sessionId: snapshot.sessionId,
    title,
    elapsedMs: snapshot.captureTimelineMs,
    captureMode: snapshot.captureMode,
    systemAudioHealthy: snapshot.systemAudioHealthy,
    microphoneHealthy: snapshot.microphoneHealthy,
    partialCapture: snapshot.partialCapture,
    gapCount: snapshot.gapCount,
    interruptionReason: snapshot.interruptionReason,
    message: snapshot.interruptionReason
      ? interruptionMessage(snapshot.interruptionReason)
      : undefined,
  };
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

function interruptionMessage(reason: string): string {
  if (reason === "system_sleep") return "电脑进入睡眠后，录制已安全暂停。";
  if (reason === "system_wake_requires_resume")
    return "电脑已唤醒，请确认后手动继续录制。";
  return "录制状态发生变化，请检查轨道与时间缺口。";
}

function commandKey(action: string): string {
  commandSequence += 1;
  return `${action}-renderer-${Date.now()}-${commandSequence}`;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
