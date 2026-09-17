import * as React from "react";
import { Mic } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { CaptionWorkspace } from "@/features/captions/caption-workspace";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureRecoveryActionRequest,
  CaptureRecoveryActionResponse,
  CaptureRecoveryItem,
  CaptureRecoveryOutcome,
  CaptureSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import {
  deriveCaptureCompactPresentation,
  type CaptureCompactAction,
  type CaptureView,
} from "./capture-presentation";
import { CaptureFooter } from "./capture-footer";
import type { CaptureLibraryOpenState } from "./capture-library-open-state";
import { RecoveryDialog, type RecoveryDialogState } from "./recovery-dialog";
import {
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "./use-recording-preference";

type CaptureControlAction = CaptureCompactAction;

let commandSequence = 0;

const STOP_CAPTURE_FAILURE_MESSAGE =
  "停止录制未完成，请重试；如需退出，可保留录音数据并在下次启动时恢复。";

function isCompletedRecoveryOutcome(
  action: "keep" | "discard",
  outcome: CaptureRecoveryOutcome,
): boolean {
  return action === "keep"
    ? outcome.result === "kept" &&
        outcome.completionCertainty === "completed" &&
        outcome.audioDurability === "durable"
    : outcome.result === "discarded" &&
        outcome.completionCertainty === "completed";
}

type CaptureWorkspaceProps = {
  capture: ApplicationSnapshot["capture"];
  recoveryEnabled?: boolean;
  libraryProjection?: ApplicationSnapshot["libraryProjection"];
  libraryOpenState?: CaptureLibraryOpenState;
  /** @deprecated Capture state is authoritative in Main and arrives via snapshots. */
  applicationRevision?: number;
  recordRequest?: number;
  detailOpen?: boolean;
  focusSessionId?: string | null;
  onPreflightResolved?: (preflight: CapturePreflight) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onStartPendingChange?: (pending: boolean) => void;
  onRetryLibraryProjection?: () => Promise<void>;
  onRetryLibraryOpen?: () => void;
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
  recoveryEnabled = true,
  libraryProjection = { phase: "idle" },
  libraryOpenState = { phase: "idle" },
  recordRequest,
  detailOpen = true,
  focusSessionId = null,
  onPreflightResolved,
  onDetailOpenChange,
  onStartPendingChange,
  onRetryLibraryProjection,
  onRetryLibraryOpen,
  children,
}: CaptureWorkspaceProps & {
  children: (projection: CaptureWorkspaceProjection) => React.ReactNode;
}) {
  const [startAttempted, setStartAttempted] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [titleEditing, setTitleEditing] = React.useState(false);
  const [confirmedActiveTitle, setConfirmedActiveTitle] = React.useState("");
  const [titleDialog, setTitleDialog] = React.useState<
    | { kind: "validation"; message: string; value: string }
    | { kind: "save"; message: string; value: string }
    | null
  >(null);
  const [recoveries, setRecoveries] = React.useState<CaptureRecoveryItem[]>([]);
  const [recoveryDialogState, setRecoveryDialogState] =
    React.useState<RecoveryDialogState>("assessing");
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
  const recoveryListGenerationRef = React.useRef(0);
  const recoveryDialogStateRef = React.useRef(recoveryDialogState);
  const frozenRecoveryRequestRef = React.useRef<{
    request: CaptureRecoveryActionRequest;
    replayed: boolean;
  } | null>(null);
  const recoveryNoticeKeysRef = React.useRef(new Set<string>());
  const automaticCleanupKeysRef = React.useRef(new Set<string>());
  const recoveryFocusFallbackRef = React.useRef<HTMLButtonElement>(null);
  const terminalActionRef = React.useRef<HTMLButtonElement>(null);
  const focusedTerminalStopSessionRef = React.useRef<string | null>(null);
  const lastRecordRequestRef = React.useRef(recordRequest ?? 0);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const titleDirtyRef = React.useRef(false);
  const titleGenerationRef = React.useRef(0);
  const startAttemptGenerationRef = React.useRef(0);
  const startEligibleRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const titleSaveRef = React.useRef<Promise<boolean> | null>(null);
  const titleSaveGenerationRef = React.useRef<number | null>(null);
  const onDetailOpenChangeRef = React.useRef(onDetailOpenChange);
  const onStartPendingChangeRef = React.useRef(onStartPendingChange);
  React.useEffect(() => {
    onDetailOpenChangeRef.current = onDetailOpenChange;
  }, [onDetailOpenChange]);
  React.useEffect(() => {
    onStartPendingChangeRef.current = onStartPendingChange;
  }, [onStartPendingChange]);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startAttemptGenerationRef.current += 1;
      onStartPendingChangeRef.current?.(false);
    };
  }, []);
  const recoverySessionId =
    capture.phase === "recovery" ? capture.sessionId : null;
  const prioritizedRecoverySessionId = focusSessionId ?? recoverySessionId;
  const recordingPreference = useRecordingPreference();

  const transitionRecoveryDialog = React.useCallback(
    (next: RecoveryDialogState) => {
      recoveryDialogStateRef.current = next;
      setRecoveryDialogState(next);
    },
    [],
  );

  const notifyPreservedRecoveries = React.useCallback(
    (items: CaptureRecoveryItem[], additionalSessionIds: string[] = []) => {
      const candidates = [
        ...items.map((item) => ({
          sessionId: item.sessionId,
          reason: item.reason ?? "none",
        })),
        ...additionalSessionIds.map((sessionId) => ({
          sessionId,
          reason: "outcome",
        })),
      ];
      const unseen = candidates.filter((item) => {
        const key = `${item.sessionId}:preserve-only:${item.reason}`;
        if (recoveryNoticeKeysRef.current.has(key)) return false;
        recoveryNoticeKeysRef.current.add(key);
        return true;
      });
      if (unseen.length === 0) return;
      toast.warning(
        `${new Set(unseen.map((item) => item.sessionId)).size} 段录音暂时无法验证，原始数据已保留。`,
        { id: "capture-recovery-preserved" },
      );
    },
    [],
  );

  const mergeRestorableRecoveries = React.useCallback(
    (items: CaptureRecoveryItem[]) => {
      const restorable = items.filter(
        (item) => item.capability === "restorable",
      );
      if (restorable.length === 0) return;
      setRecoveries((current) => {
        const byId = new Map(current.map((item) => [item.sessionId, item]));
        for (const item of restorable) byId.set(item.sessionId, item);
        return [...byId.values()];
      });
      if (!recoveryDialogStateRef.current.startsWith("pending-")) {
        transitionRecoveryDialog("choice");
      }
    },
    [transitionRecoveryDialog],
  );

  const runAutomaticCleanup = React.useCallback(
    async (items: CaptureRecoveryItem[]) => {
      const targets = items.filter((item) => {
        if (item.capability !== "discard-only") return false;
        const key = `${item.sessionId}:discard-only:${item.reason ?? "none"}`;
        if (automaticCleanupKeysRef.current.has(key)) return false;
        automaticCleanupKeysRef.current.add(key);
        return true;
      });
      if (targets.length === 0) return;
      const request: CaptureRecoveryActionRequest = {
        action: "discard",
        intent: "automatic-discard-only-cleanup",
        sessionIds: targets.map((item) => item.sessionId),
        idempotencyKey: commandKey("automatic-recovery-cleanup"),
      };
      let response: CaptureRecoveryActionResponse | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await window.voice2text.actOnCaptureRecovery(request);
        } catch {
          response = null;
        }
        if (!response) continue;
        const currentResponse = response;
        const unknown =
          request.sessionIds.some(
            (sessionId) =>
              !currentResponse.outcomes.some(
                (outcome) => outcome.sessionId === sessionId,
              ),
          ) ||
          currentResponse.outcomes.some(
            (outcome) =>
              request.sessionIds.includes(outcome.sessionId) &&
              (outcome.completionCertainty === "unknown" ||
                outcome.result === "failed"),
          );
        if (!unknown) break;
      }
      if (!response) {
        toast.warning("数据尚未确认删除，下次启动将重新检查。", {
          id: "capture-recovery-cleanup-unconfirmed",
        });
        return;
      }
      const authoritativeById = new Map(
        response.recoveries.map((item) => [item.sessionId, item]),
      );
      mergeRestorableRecoveries(response.recoveries);
      const outcomes = response.outcomes.filter((outcome) =>
        request.sessionIds.includes(outcome.sessionId),
      );
      const allCompleted =
        outcomes.length === request.sessionIds.length &&
        outcomes.every(
          (outcome) =>
            outcome.result === "discarded" &&
            outcome.completionCertainty === "completed",
        );
      if (allCompleted) {
        const noticeKey = `automatic-discarded:${[...request.sessionIds].sort().join(",")}`;
        if (!recoveryNoticeKeysRef.current.has(noticeKey)) {
          recoveryNoticeKeysRef.current.add(noticeKey);
          toast.success(`${outcomes.length} 段无可恢复内容的录音数据已处理。`, {
            id: "capture-recovery-cleanup-completed",
          });
        }
        return;
      }
      const hasUnconfirmed = outcomes.some((outcome) => {
        if (
          outcome.result === "discarded" &&
          outcome.completionCertainty === "completed"
        )
          return false;
        const reclassified = authoritativeById.get(outcome.sessionId);
        return (
          reclassified?.capability !== "restorable" &&
          reclassified?.capability !== "preserve-only"
        );
      });
      if (hasUnconfirmed || outcomes.length < request.sessionIds.length) {
        toast.warning("数据尚未确认删除，下次启动将重新检查。", {
          id: "capture-recovery-cleanup-unconfirmed",
        });
      }
    },
    [mergeRestorableRecoveries],
  );

  React.useEffect(() => {
    if (!recoveryEnabled) {
      recoveryListGenerationRef.current += 1;
      return;
    }
    if (recoveryDialogStateRef.current.startsWith("pending-")) return;

    let active = true;
    const generation = ++recoveryListGenerationRef.current;
    const loadTarget = prioritizedRecoverySessionId ?? "all";
    void window.voice2text
      .listCaptureRecoveries()
      .then((values) => {
        if (!active || generation !== recoveryListGenerationRef.current) return;
        setError(null);
        const nextRecoveries = prioritizedRecoverySessionId
          ? [...values].sort((left, right) =>
              left.sessionId === prioritizedRecoverySessionId
                ? -1
                : right.sessionId === prioritizedRecoverySessionId
                  ? 1
                  : 0,
            )
          : values;
        const restorable = nextRecoveries.filter(
          (item) => item.capability === "restorable",
        );
        setRecoveries(restorable);
        void runAutomaticCleanup(nextRecoveries);
        if (!recoveryDialogStateRef.current.startsWith("pending-")) {
          transitionRecoveryDialog(restorable.length > 0 ? "choice" : "hidden");
        }
        setLoadedRecoveryTarget(loadTarget);
      })
      .catch((reason: unknown) => {
        if (active && generation === recoveryListGenerationRef.current) {
          setLoadedRecoveryTarget(loadTarget);
          transitionRecoveryDialog("hidden");
          setError(userFacingError(reason, "无法检查可恢复录制"));
        }
      });
    return () => {
      active = false;
    };
  }, [
    prioritizedRecoverySessionId,
    recoveryEnabled,
    runAutomaticCleanup,
    transitionRecoveryDialog,
  ]);

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
        setTitleDialog({
          kind: "validation",
          message: validation.message!,
          value: candidate,
        });
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
  const visibleError = recoveryEnabled && !stopFailureSettled ? error : null;

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
      onFailure?: (reason: unknown) => boolean | void,
    ) => {
      if (pendingRef.current.has(identity)) return;
      pendingRef.current.add(identity);
      setPendingAction(identity);
      setOperationMessage(label);
      setError(null);
      try {
        await operation();
      } catch (reason: unknown) {
        if (!mountedRef.current || onFailure?.(reason) === false) return;
        setError(userFacingError(reason, failureMessage));
      } finally {
        pendingRef.current.delete(identity);
        if (mountedRef.current) {
          setPendingAction((current) =>
            current === identity ? null : current,
          );
        }
      }
    },
    [],
  );

  const startEligible =
    capture.phase !== "recovery" &&
    (!activeCapture || canBeginAnotherCapture(activeCapture)) &&
    recoveries.length === 0 &&
    !focusSessionId;
  React.useLayoutEffect(() => {
    startEligibleRef.current = startEligible;
    if (!startEligible) {
      startAttemptGenerationRef.current += 1;
      void Promise.resolve().then(() => {
        if (!startEligibleRef.current) setStartAttempted(false);
      });
    }
  }, [startEligible]);

  const beginCapture = React.useCallback(() => {
    if (!startEligibleRef.current || pendingRef.current.has("start")) return;
    const generation = ++startAttemptGenerationRef.current;
    const startIsCurrent = () =>
      generation === startAttemptGenerationRef.current &&
      startEligibleRef.current;
    const cancelStaleStart = () => {
      if (generation === startAttemptGenerationRef.current) {
        setStartAttempted(false);
      }
    };
    onStartPendingChangeRef.current?.(true);
    void runExclusive(
      "start",
      "正在开始录制",
      async () => {
        setStartAttempted(true);
        const result = await window.voice2text.preflightCapture({
          requestPermissions: true,
          captionEnabled: true,
        });
        if (!startIsCurrent()) {
          cancelStaleStart();
          return;
        }
        onPreflightResolved?.(result);
        const defaultMicrophone = resolveRecordingMicrophone(
          result.microphones,
          recordingPreference.microphoneDeviceId,
        );
        if (!result.canStart || !defaultMicrophone) {
          throw new Error(
            "当前录制条件不可用，请检查麦克风权限和磁盘空间后重试。",
          );
        }
        titleDirtyRef.current = false;
        const suggestedTitle = (await window.voice2text.suggestCaptureTitle())
          .title;
        if (!startIsCurrent()) {
          cancelStaleStart();
          return;
        }
        await window.voice2text.startCapture({
          title: suggestedTitle.trim(),
          refreshSuggestedTitle: true,
          microphoneDeviceId: defaultMicrophone.id,
          captionEnabled: result.captionModelAvailable,
          idempotencyKey: commandKey("start"),
        });
        if (!startIsCurrent()) {
          cancelStaleStart();
          return;
        }
        setDismissedSessionId(null);
        setStartAttempted(false);
        setOperationMessage("录制已经开始");
      },
      "无法开始录制",
      () => {
        if (!startIsCurrent()) {
          cancelStaleStart();
          return false;
        }
        onDetailOpenChangeRef.current?.(true);
        return true;
      },
    ).finally(() => onStartPendingChangeRef.current?.(false));
  }, [
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
        beginCapture();
      });
    }
  }, [activeCapture, beginCapture, recordRequest]);

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
        action === "stop"
          ? () => {
              setStopConfirmationSessionId(null);
            }
          : undefined,
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

  const actOnRecoveries = React.useCallback(
    (action: "keep" | "discard") => {
      if (recoveryDialogStateRef.current.startsWith("pending-")) return;
      const retrying = recoveryDialogStateRef.current.startsWith("retry-");
      let frozen = frozenRecoveryRequestRef.current;
      if (!retrying || !frozen || frozen.request.action !== action) {
        const sessionIds = recoveries.map((item) => item.sessionId);
        if (sessionIds.length === 0) {
          transitionRecoveryDialog("hidden");
          return;
        }
        frozen = {
          request: {
            action,
            intent: "user-decision",
            sessionIds,
            idempotencyKey: commandKey(`recovery-${action}`),
          },
          replayed: false,
        };
        frozenRecoveryRequestRef.current = frozen;
      }

      const pendingState: RecoveryDialogState =
        action === "keep" ? "pending-restore" : "pending-delete";
      const retryState: RecoveryDialogState =
        action === "keep" ? "retry-restore" : "retry-delete";
      recoveryListGenerationRef.current += 1;
      transitionRecoveryDialog(pendingState);

      const execute = async (): Promise<void> => {
        const activeRequest = frozenRecoveryRequestRef.current;
        if (!activeRequest) return;
        let response: CaptureRecoveryActionResponse;
        try {
          response = await window.voice2text.actOnCaptureRecovery(
            activeRequest.request,
          );
        } catch {
          if (!activeRequest.replayed) {
            activeRequest.replayed = true;
            await execute();
            return;
          }
          transitionRecoveryDialog(retryState);
          return;
        }

        const targetIds = new Set(activeRequest.request.sessionIds);
        const relevantOutcomes = response.outcomes.filter((outcome) =>
          targetIds.has(outcome.sessionId),
        );
        const outcomesById = new Map(
          relevantOutcomes.map((outcome) => [outcome.sessionId, outcome]),
        );
        const unknownIds = new Set<string>();
        for (const sessionId of activeRequest.request.sessionIds) {
          const outcome = outcomesById.get(sessionId);
          const terminal = outcome
            ? isCompletedRecoveryOutcome(action, outcome)
            : false;
          const deliberatelyNotCompleted =
            outcome?.result === "preserved" ||
            (outcome?.result === "conflict" &&
              outcome.completionCertainty === "not-completed");
          if (!terminal && !deliberatelyNotCompleted) {
            unknownIds.add(sessionId);
          }
        }
        if (unknownIds.size > 0 && !activeRequest.replayed) {
          activeRequest.replayed = true;
          await execute();
          return;
        }

        const completedIds = new Set(
          relevantOutcomes
            .filter((outcome) => isCompletedRecoveryOutcome(action, outcome))
            .map((outcome) => outcome.sessionId),
        );
        const authoritative = new Map(
          response.recoveries.map((item) => [item.sessionId, item]),
        );
        const preserved = response.recoveries.filter(
          (item) =>
            targetIds.has(item.sessionId) &&
            item.capability === "preserve-only",
        );
        const preservedIds = new Set(preserved.map((item) => item.sessionId));
        notifyPreservedRecoveries(
          preserved,
          relevantOutcomes
            .filter(
              (outcome) =>
                outcome.result === "preserved" &&
                !preservedIds.has(outcome.sessionId),
            )
            .map((outcome) => outcome.sessionId),
        );

        if (action === "keep" && completedIds.size > 0) {
          toast.success("录音已恢复并保存", {
            id: "capture-recovery-completed",
          });
          if (
            relevantOutcomes.some(
              (outcome) =>
                completedIds.has(outcome.sessionId) &&
                outcome.transcriptionHandoff === "failed",
            )
          ) {
            toast.warning("录音已恢复；转写暂未开始，可稍后重试。", {
              id: "capture-recovery-transcription-failed",
            });
          }
        }

        const currentById = new Map(
          recoveries.map((item) => [item.sessionId, item]),
        );
        const remaining: CaptureRecoveryItem[] = [];
        for (const sessionId of activeRequest.request.sessionIds) {
          if (completedIds.has(sessionId)) continue;
          const next = authoritative.get(sessionId);
          if (next?.capability === "preserve-only") continue;
          if (unknownIds.has(sessionId)) {
            const current = currentById.get(sessionId);
            if (current) remaining.push(current);
            continue;
          }
          if (next?.capability === "restorable") remaining.push(next);
        }
        for (const item of response.recoveries) {
          if (
            item.capability === "restorable" &&
            !targetIds.has(item.sessionId)
          ) {
            remaining.push(item);
          }
        }
        setRecoveries(remaining);

        if (unknownIds.size > 0) {
          transitionRecoveryDialog(retryState);
          return;
        }
        frozenRecoveryRequestRef.current = null;
        const nextState: RecoveryDialogState =
          remaining.length > 0 ? "choice" : "hidden";
        transitionRecoveryDialog(nextState);
      };
      void execute();
    },
    [notifyPreservedRecoveries, recoveries, transitionRecoveryDialog],
  );

  const busy = pendingAction !== null;
  const beginAnotherCapture = React.useCallback(() => {
    if (!activeCapture) return;
    setDismissedSessionId(activeCapture.sessionId);
    beginCapture();
  }, [activeCapture, beginCapture]);

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
    !startAttempted &&
    recoveries.length === 0 &&
    !focusSessionId;
  const recoveryDialogOpen =
    recoveryEnabled &&
    recoveryDialogState !== "assessing" &&
    recoveryDialogState !== "hidden";

  const detail =
    detailOpen && !workspaceHidden && !recoveryDialogOpen ? (
      <section
        role="region"
        aria-label="录制详情"
        aria-busy={busy}
        className="mx-auto w-full max-w-3xl space-y-5"
      >
        <CaptureLibraryProjectionStatus
          projection={libraryProjection}
          openState={libraryOpenState}
          busy={busy}
          onRetryProjection={() => {
            if (!onRetryLibraryProjection) return;
            void runExclusive(
              `library-projection-${libraryProjection.phase === "failed" ? libraryProjection.intentId : "retry"}`,
              "正在重试加入音频资料库",
              onRetryLibraryProjection,
              "无法重试加入音频资料库",
            );
          }}
          onRetryOpen={onRetryLibraryOpen}
        />
        {busy && !focusedActiveCapture ? (
          <p className="mb-3 border-b bg-muted/40 pb-3 text-sm font-medium">
            {operationMessage}
          </p>
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
          <CaptureStart
            startAttempted={startAttempted}
            busy={busy}
            recoveryFocusFallbackRef={recoveryFocusFallbackRef}
            onStart={beginCapture}
          />
        ) : null}
      </section>
    ) : null;

  const titleEditable = selectedActiveCapture
    ? isCaptureTitleEditable(selectedActiveCapture)
    : false;
  const customTitle =
    detailOpen && selectedActiveCapture && (title || titleEditing) ? (
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
        state={recoveryDialogOpen ? recoveryDialogState : "hidden"}
        items={recoveries}
        onRestore={() => actOnRecoveries("keep")}
        onDelete={() => actOnRecoveries("discard")}
        onRequestFocusFallback={() => {
          const recordingEntry =
            recoveryFocusFallbackRef.current ??
            document.querySelector<HTMLElement>("[data-recording-entry]");
          recordingEntry?.focus();
        }}
      />
      <TitleErrorDialog
        state={titleDialog}
        onClose={() => setTitleDialog(null)}
        onSubmit={(value) => {
          void commitTitle(value).then((saved) => {
            if (saved) setTitleDialog(null);
          });
        }}
      />
      <CaptureErrorDialog
        message={visibleError}
        onClose={() => setError(null)}
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

function CaptureLibraryProjectionStatus({
  projection,
  openState,
  busy,
  onRetryProjection,
  onRetryOpen,
}: {
  projection: ApplicationSnapshot["libraryProjection"];
  openState: CaptureLibraryOpenState;
  busy: boolean;
  onRetryProjection: () => void;
  onRetryOpen?: () => void;
}) {
  if (openState.phase === "opening") {
    return (
      <section role="status" className="border-y py-4">
        <h2 className="text-sm font-semibold">正在打开新音频</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          音频已加入资料库，正在打开详情。
        </p>
      </section>
    );
  }
  if (openState.phase === "open_failed") {
    return (
      <section role="alert" className="border-y py-4">
        <h2 className="text-sm font-semibold">新音频暂时无法打开</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {openState.message}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={onRetryOpen}
        >
          重试打开音频
        </Button>
      </section>
    );
  }
  if (projection.phase === "registering") {
    return (
      <section role="status" className="border-y py-4">
        <h2 className="text-sm font-semibold">正在加入音频资料库</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          录音已经保存，完成后会自动打开。
        </p>
      </section>
    );
  }
  if (projection.phase === "failed") {
    return (
      <section role="alert" className="border-y py-4">
        <h2 className="text-sm font-semibold">音频资料库未更新</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {projection.message}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={onRetryProjection}
        >
          重试加入音频资料库
        </Button>
      </section>
    );
  }
  return null;
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
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.currentTarget.blur();
            }
          }}
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
    <Button
      type="button"
      variant="text"
      size="sm"
      className="-mx-1.5 min-w-0 cursor-text justify-start truncate px-1.5 font-semibold"
      title="点击编辑录制名称"
      onClick={onEdit}
    >
      {value}
    </Button>
  );
}

function TitleErrorDialog({
  state,
  onClose,
  onSubmit,
}: {
  state:
    | { kind: "validation"; message: string; value: string }
    | { kind: "save"; message: string; value: string }
    | null;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        {state?.kind === "validation" ? (
          <TitleValidationDialogBody
            key={state.value}
            state={state}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>录制名称未保存</DialogTitle>
              <DialogDescription>{state?.message ?? ""}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              {state ? (
                <Button type="button" onClick={() => onSubmit(state.value)}>
                  重试
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CaptureErrorDialog({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>录制遇到问题</DialogTitle>
          <DialogDescription>{message ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">知道了</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TitleValidationDialogBody({
  state,
  onClose,
  onSubmit,
}: {
  state: { kind: "validation"; message: string; value: string };
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState(state.value);
  return (
    <>
      <DialogHeader>
        <DialogTitle>请检查录制名称</DialogTitle>
        <DialogDescription>{state.message}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="capture-title-correction">录制名称</FieldLabel>
        <Input
          id="capture-title-correction"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          关闭
        </Button>
        <Button type="button" onClick={() => onSubmit(draft)}>
          保存名称
        </Button>
      </DialogFooter>
    </>
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

function CaptureStart({
  startAttempted,
  busy,
  recoveryFocusFallbackRef,
  onStart,
}: {
  startAttempted: boolean;
  busy: boolean;
  recoveryFocusFallbackRef: React.RefObject<HTMLButtonElement | null>;
  onStart: () => void;
}) {
  if (!startAttempted) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Mic className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">音频录制</h2>
        </div>
        <Button
          ref={recoveryFocusFallbackRef}
          data-recording-entry="capture-workspace"
          type="button"
          size="sm"
          disabled={busy}
          onClick={onStart}
        >
          开始录制
        </Button>
      </div>
    );
  }

  if (busy) return null;

  return (
    <div className="flex justify-end">
      <Button type="button" onClick={onStart}>
        <Mic aria-hidden="true" />
        重试开始录制
      </Button>
    </div>
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
      {capture.message && capture.interruptionReason !== "capture_stop_slow" ? (
        <p className="text-sm">{capture.message}</p>
      ) : null}
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
