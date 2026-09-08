import * as React from "react";
import { Mic, Pencil, RotateCcw } from "lucide-react";

import { ApplicationBlocker } from "@/components/application-blocker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CaptionWorkspace } from "@/features/captions/caption-workspace";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureRecoveryItem,
  CaptureSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import {
  deriveCaptureCompactPresentation,
  type CaptureCompactAction,
  type CaptureView,
} from "./capture-presentation";
import { CaptureFooter } from "./capture-footer";
import {
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "./use-recording-preference";

type CaptureControlAction = CaptureCompactAction;

let commandSequence = 0;

const STOP_CAPTURE_FAILURE_MESSAGE =
  "停止录制未完成，请重试；如需退出，可保留录音数据并在下次启动时恢复。";

type CaptureWorkspaceProps = {
  capture: ApplicationSnapshot["capture"];
  /** @deprecated Capture state is authoritative in Main and arrives via snapshots. */
  applicationRevision?: number;
  recordRequest?: number;
  detailOpen?: boolean;
  focusSessionId?: string | null;
  autoOpenRecoveries?: boolean;
  onPreflightResolved?: (preflight: CapturePreflight) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenLocalModels?: () => void;
};

export type CaptureWorkspaceProjection = {
  customTitle: React.ReactNode;
  content: React.ReactNode;
  footer: React.ReactNode;
};

export function CaptureWorkspace(props: CaptureWorkspaceProps) {
  return (
    <CaptureWorkspaceController {...props}>
      {({ customTitle, content, footer }) => (
        <>
          {customTitle ? (
            <div className="mb-4 min-w-0">{customTitle}</div>
          ) : null}
          {content}
          {footer}
        </>
      )}
    </CaptureWorkspaceController>
  );
}

export function CaptureWorkspaceController({
  capture,
  recordRequest,
  detailOpen = true,
  focusSessionId = null,
  autoOpenRecoveries = false,
  onPreflightResolved,
  onDetailOpenChange,
  onOpenLocalModels,
  children,
}: CaptureWorkspaceProps & {
  children: (projection: CaptureWorkspaceProjection) => React.ReactNode;
}) {
  const [preflight, setPreflight] = React.useState<CapturePreflight | null>(
    null,
  );
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [titleLoading, setTitleLoading] = React.useState(false);
  const [titleEditing, setTitleEditing] = React.useState(false);
  const [confirmedActiveTitle, setConfirmedActiveTitle] = React.useState("");
  const [titleDialog, setTitleDialog] = React.useState<
    | { kind: "load" | "validation"; message: string }
    | { kind: "save"; message: string; value: string }
    | null
  >(null);
  const [captionEnabled, setCaptionEnabled] = React.useState(true);
  const [microphoneDeviceId, setMicrophoneDeviceId] = React.useState("");
  const [recoveries, setRecoveries] = React.useState<CaptureRecoveryItem[]>([]);
  const [loadedRecoveryTarget, setLoadedRecoveryTarget] = React.useState<
    string | null
  >(null);
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
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const titleDirtyRef = React.useRef(false);
  const titleGenerationRef = React.useRef(0);
  const suggestionGenerationRef = React.useRef(0);
  const titleSaveRef = React.useRef<Promise<boolean> | null>(null);
  const titleSaveGenerationRef = React.useRef<number | null>(null);
  const onDetailOpenChangeRef = React.useRef(onDetailOpenChange);
  React.useEffect(() => {
    onDetailOpenChangeRef.current = onDetailOpenChange;
  }, [onDetailOpenChange]);
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
  }, [autoOpenRecoveries, prioritizedRecoverySessionId]);

  const captureCandidate =
    capture.phase === "idle" || capture.phase === "recovery" ? null : capture;
  const activeCapture =
    captureCandidate?.sessionId === dismissedSessionId
      ? null
      : captureCandidate;
  const selectedActiveCapture =
    !prioritizedRecoverySessionId ||
    activeCapture?.sessionId === prioritizedRecoverySessionId
      ? activeCapture
      : null;
  const persistedSessionId = selectedActiveCapture?.sessionId ?? null;
  const activeTitle = selectedActiveCapture?.title ?? "";
  React.useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (!persistedSessionId) {
        setConfirmedActiveTitle("");
        setTitleEditing(false);
        return;
      }
      setConfirmedActiveTitle(activeTitle);
      if (!titleDirtyRef.current && !titleSaveRef.current)
        setTitle(activeTitle);
    });
    return () => {
      active = false;
    };
  }, [persistedSessionId, activeTitle]);

  React.useLayoutEffect(() => {
    if (!titleEditing) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [titleEditing]);

  const loadSuggestedTitle = React.useCallback(async () => {
    const generation = ++suggestionGenerationRef.current;
    titleDirtyRef.current = false;
    setTitle("");
    setTitleLoading(true);
    try {
      const result = await window.voice2text.suggestCaptureTitle();
      if (generation !== suggestionGenerationRef.current) return false;
      if (!titleDirtyRef.current) setTitle(result.title);
      setTitleLoading(false);
      return true;
    } catch (reason: unknown) {
      if (generation !== suggestionGenerationRef.current) return false;
      setTitleLoading(false);
      setSetupOpen(false);
      onDetailOpenChangeRef.current?.(false);
      setTitleDialog({
        kind: "load",
        message: userFacingError(reason, "无法生成录制名称"),
      });
      return false;
    }
  }, []);

  const validateTitle = React.useCallback((value: string) => {
    const trimmed = value.trim();
    const contentLength = trimmed.startsWith("Recover-")
      ? trimmed.slice("Recover-".length).length
      : trimmed.length;
    if (!trimmed) return { value: null, message: "录制名称不能为空。" };
    if (contentLength > 50)
      return { value: null, message: "录制名称最多包含 50 个字符。" };
    return { value: trimmed, message: null };
  }, []);

  const commitTitle = React.useCallback(
    async (override?: string): Promise<boolean> => {
      if (titleSaveRef.current) return titleSaveRef.current;
      const candidate = override ?? title;
      const validation = validateTitle(candidate);
      if (!validation.value) {
        setTitleDialog({ kind: "validation", message: validation.message! });
        return false;
      }
      const nextTitle = validation.value;
      if (!persistedSessionId) {
        setTitle(nextTitle);
        setTitleEditing(false);
        return true;
      }
      if (nextTitle === confirmedActiveTitle) {
        setTitle(nextTitle);
        titleDirtyRef.current = false;
        setTitleEditing(false);
        return true;
      }
      const generation = titleGenerationRef.current;
      const sessionId = persistedSessionId;
      titleSaveGenerationRef.current = generation;
      const promise = window.voice2text
        .renameCaptureSession({ sessionId, title: nextTitle })
        .then(() => {
          if (generation === titleGenerationRef.current) {
            setConfirmedActiveTitle(nextTitle);
            setTitle(nextTitle);
            titleDirtyRef.current = false;
            setTitleEditing(false);
          }
          return true;
        })
        .catch((reason: unknown) => {
          if (generation === titleGenerationRef.current) {
            setTitleDialog({
              kind: "save",
              value: nextTitle,
              message: userFacingError(reason, "录制名称未保存"),
            });
          }
          return false;
        })
        .finally(() => {
          if (titleSaveRef.current === promise) {
            titleSaveRef.current = null;
            titleSaveGenerationRef.current = null;
          }
        });
      titleSaveRef.current = promise;
      return promise;
    },
    [confirmedActiveTitle, persistedSessionId, title, validateTitle],
  );

  const settleTitleBeforeStop = React.useCallback(async () => {
    const pending = titleSaveRef.current;
    if (pending) {
      const pendingGeneration = titleSaveGenerationRef.current;
      const saved = await pending;
      if (
        titleDirtyRef.current &&
        pendingGeneration !== null &&
        pendingGeneration !== titleGenerationRef.current
      ) {
        return commitTitle();
      }
      return saved;
    }
    return titleDirtyRef.current ? await commitTitle() : true;
  }, [commitTitle]);
  const stopConfirmationOpen = Boolean(
    activeCapture &&
    activeCapture.sessionId === stopConfirmationSessionId &&
    activeCapture.sessionId !== successfulTerminalStopSessionId &&
    !["completed", "failed", "recovery"].includes(activeCapture.phase),
  );

  const stopFailureSettled =
    error === STOP_CAPTURE_FAILURE_MESSAGE &&
    (["completed", "failed", "recovery"].includes(capture.phase) ||
      (capture.phase === "partial_capture" &&
        !capture.systemAudioHealthy &&
        !capture.microphoneHealthy));
  const visibleError = stopFailureSettled ? null : error;

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
    async (
      identity: string,
      label: string,
      operation: () => Promise<void>,
      failureMessage = "录制操作未完成",
    ) => {
      if (pendingRef.current.has(identity)) return;
      pendingRef.current.add(identity);
      setPendingAction(identity);
      setOperationMessage(label);
      setError(null);
      try {
        await operation();
      } catch (reason: unknown) {
        setError(userFacingError(reason, failureMessage));
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
      onDetailOpenChangeRef.current?.(true);
      setOperationMessage("录制设置已打开");
      await loadSuggestedTitle();
    });
  }, [
    captionEnabled,
    onPreflightResolved,
    loadSuggestedTitle,
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
        refreshSuggestedTitle: !titleDirtyRef.current,
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
        stop: "正在停止并保存",
      }[action];
      const sessionId = activeCapture.sessionId;
      void runExclusive(
        `control-${sessionId}`,
        operationLabel,
        async () => {
          const result = await window.voice2text.controlCapture({
            action,
            sessionId,
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
        action === "stop" ? STOP_CAPTURE_FAILURE_MESSAGE : undefined,
      );
    },
    [activeCapture, runExclusive, successfulTerminalStopSessionId],
  );

  const requestControl = React.useCallback(
    (action: CaptureControlAction) => {
      if (action === "stop") {
        if (!titleDirtyRef.current) {
          if (
            activeCapture &&
            activeCapture.sessionId !== successfulTerminalStopSessionId
          ) {
            setStopConfirmationSessionId(activeCapture.sessionId);
          }
          return;
        }
        void settleTitleBeforeStop().then((settled) => {
          if (
            settled &&
            activeCapture &&
            activeCapture.sessionId !== successfulTerminalStopSessionId
          ) {
            setStopConfirmationSessionId(activeCapture.sessionId);
          }
        });
        return;
      }
      control(action);
    },
    [
      activeCapture,
      control,
      settleTitleBeforeStop,
      successfulTerminalStopSessionId,
    ],
  );

  const confirmStop = React.useCallback(() => {
    control("stop");
  }, [control]);

  const recoverAll = React.useCallback(
    (items: CaptureRecoveryItem[], action: "keep" | "discard") => {
      void runExclusive(
        "recovery-all",
        action === "keep" ? "正在恢复数据" : "正在丢弃数据",
        async () => {
          const completedSessionIds = new Set<string>();
          try {
            for (const item of items) {
              await window.voice2text.actOnCaptureRecovery({
                action,
                sessionId: item.sessionId,
                idempotencyKey: commandKey(action),
              });
              completedSessionIds.add(item.sessionId);
            }
          } finally {
            if (completedSessionIds.size > 0) {
              setRecoveries((current) =>
                current.filter(
                  (candidate) => !completedSessionIds.has(candidate.sessionId),
                ),
              );
            }
          }
          setOperationMessage(
            action === "keep" ? "数据已恢复" : "待恢复数据已丢弃",
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
  const workspaceHidden =
    recordRequest !== undefined &&
    !activeCapture &&
    !setupOpen &&
    recoveries.length === 0 &&
    !focusSessionId;
  const recoveryDialogOpen =
    recoveries.length > 0 &&
    (detailOpen || autoOpenRecoveries || Boolean(focusSessionId));

  const detail =
    detailOpen && !workspaceHidden && !recoveryDialogOpen ? (
      <section
        role="region"
        aria-label="录制详情"
        aria-busy={busy}
        className="mx-auto w-full max-w-3xl space-y-5"
      >
        {busy && !focusedActiveCapture ? (
          <p className="mb-3 border-b bg-muted/40 pb-3 text-sm font-medium">
            {operationMessage}
          </p>
        ) : null}
        {visibleError ? (
          <div
            role="alert"
            className="mb-3 border-y border-destructive/40 bg-destructive/5 py-3 text-sm"
          >
            {visibleError}
          </div>
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
            terminalActionRef={terminalActionRef}
            onBeginAnother={beginAnotherCapture}
          />
        ) : !focusSessionId ? (
          <CaptureSetup
            setupOpen={setupOpen}
            preflight={preflight}
            busy={busy}
            onCheck={checkPreflight}
            onStart={start}
            titleReady={!titleLoading && Boolean(title)}
            captionAvailable={preflight?.captionModelAvailable ?? true}
            captionEnabled={captionEnabled}
            onOpenLocalModels={onOpenLocalModels}
          />
        ) : null}
      </section>
    ) : null;

  const titleEditable = selectedActiveCapture
    ? isCaptureTitleEditable(selectedActiveCapture)
    : setupOpen;
  const customTitle =
    detailOpen && (title || titleEditing) && !titleLoading ? (
      <CaptureTitleEditor
        value={title}
        editing={titleEditing}
        editable={titleEditable}
        onEdit={() => setTitleEditing(true)}
        inputRef={titleInputRef}
        onChange={(value) => {
          titleGenerationRef.current += 1;
          titleDirtyRef.current = true;
          setTitle(value);
        }}
        onBlur={() => void commitTitle()}
      />
    ) : null;
  const dialogs = (
    <>
      <RecoveryDialog
        open={recoveryDialogOpen}
        itemCount={recoveries.length}
        busy={busy}
        error={visibleError}
        operationMessage={operationMessage}
        onRestoreAll={() => recoverAll(recoveries, "keep")}
        onDiscardAll={() => recoverAll(recoveries, "discard")}
      />
      <TitleErrorDialog
        state={titleDialog}
        onClose={() => setTitleDialog(null)}
        onRetry={(value) => {
          setTitleDialog(null);
          void commitTitle(value);
        }}
      />
    </>
  );
  const footerCapture: CaptureView | null = focusedActiveCapture;
  const footer =
    detailOpen && footerCapture ? (
      <CaptureFooter
        capture={footerCapture}
        busy={busy}
        stopConfirmationOpen={stopConfirmationOpen}
        stopSubmitted={
          footerCapture.sessionId === successfulTerminalStopSessionId
        }
        statusOverride={
          footerCapture.phase !== "finalizing" &&
          pendingAction?.startsWith("control-")
            ? operationMessage
            : undefined
        }
        onCancelStop={() => setStopConfirmationSessionId(null)}
        onConfirmStop={confirmStop}
        onControl={requestControl}
      />
    ) : null;

  return children({
    customTitle,
    content: (
      <>
        {detail}
        {dialogs}
      </>
    ),
    footer,
  });
}

function CaptureTitleEditor({
  value,
  editing,
  editable,
  inputRef,
  onEdit,
  onChange,
  onBlur,
}: {
  value: string;
  editing: boolean;
  editable: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onEdit: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  if (editing && editable) {
    return (
      <div className="flex min-w-0 items-center">
        <Input
          ref={inputRef}
          aria-label="录制名称"
          className="min-w-[180px] w-auto [field-sizing:content]"
          value={value}
          maxLength={value.startsWith("Recover-") ? 58 : 50}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={onBlur}
        />
      </div>
    );
  }
  if (!editable) {
    return (
      <h1 className="min-w-0 truncate text-sm leading-snug font-semibold">
        {value}
      </h1>
    );
  }
  return (
    <TooltipProvider>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="min-w-0 truncate text-left text-sm leading-snug font-semibold"
          onClick={onEdit}
        >
          {value}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0"
              aria-label="编辑录制名称"
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>编辑录制名称</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function TitleErrorDialog({
  state,
  onClose,
  onRetry,
}: {
  state:
    | { kind: "load" | "validation"; message: string }
    | { kind: "save"; message: string; value: string }
    | null;
  onClose: () => void;
  onRetry: (value: string) => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {state?.kind === "load"
              ? "无法准备录制名称"
              : state?.kind === "save"
                ? "录制名称未保存"
                : "请检查录制名称"}
          </DialogTitle>
          <DialogDescription>{state?.message ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {state?.kind === "save" ? "取消" : "关闭"}
          </Button>
          {state?.kind === "save" ? (
            <Button type="button" onClick={() => onRetry(state.value)}>
              重试
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isCaptureTitleEditable(capture: CaptureView): boolean {
  if (["finalizing", "completed", "failed"].includes(capture.phase)) {
    return false;
  }
  if (capture.phase !== "partial_capture") return true;
  return Boolean(capture.systemAudioHealthy || capture.microphoneHealthy);
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
  busy,
  onCheck,
  onStart,
  titleReady,
  captionAvailable,
  captionEnabled,
  onOpenLocalModels,
}: {
  setupOpen: boolean;
  preflight: CapturePreflight | null;
  busy: boolean;
  onCheck: () => void;
  onStart: () => void;
  titleReady: boolean;
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
        {readyToStart && titleReady ? (
          <Button type="button" disabled={busy} onClick={onStart}>
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
  terminalActionRef,
  onBeginAnother,
}: {
  capture: CaptureView;
  busy: boolean;
  terminalActionRef: React.RefObject<HTMLButtonElement | null>;
  onBeginAnother: () => void;
}) {
  const presentation = deriveCaptureCompactPresentation(capture);
  const running = presentation?.action === "pause";
  const finalizedPartial = capture.phase === "partial_capture" && !running;
  return (
    <section aria-label="当前录制" className="space-y-3">
      {capture.message ? <p className="text-sm">{capture.message}</p> : null}
      {capture.phase === "partial_capture" || capture.partialCapture ? (
        <PartialCaptureStatus capture={capture} />
      ) : null}
      <ActiveCaptionWorkspace sessionId={capture.sessionId} />
      {!presentation?.canStop &&
      (capture.phase === "completed" ||
        capture.phase === "failed" ||
        finalizedPartial) ? (
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

function RecoveryDialog({
  open,
  itemCount,
  busy,
  error,
  operationMessage,
  onRestoreAll,
  onDiscardAll,
}: {
  open: boolean;
  itemCount: number;
  busy: boolean;
  error: string | null;
  operationMessage: string;
  onRestoreAll: () => void;
  onDiscardAll: () => void;
}) {
  return (
    <ApplicationBlocker
      open={open}
      title="发现可恢复录制"
      description={`发现 ${itemCount} 段未完成的录音，可一次恢复并保存。`}
      onDismiss={busy ? undefined : onDiscardAll}
    >
      <div className="space-y-2">
        {busy ? (
          <p className="border-y bg-muted/40 py-3 text-sm font-medium">
            {operationMessage}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="border-y border-destructive/40 bg-destructive/5 py-3 text-sm"
          >
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" disabled={busy} onClick={onRestoreAll}>
          <RotateCcw />
          {busy ? "正在恢复…" : "恢复数据"}
        </Button>
      </DialogFooter>
    </ApplicationBlocker>
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
