import * as React from "react";
import {
  Ban,
  CircleAlert,
  Clock3,
  FileInput,
  LoaderCircle,
  Mic,
  RotateCcw,
  Search,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarInput,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AudioDetailWorkspace } from "@/features/audios/audio-workspace-feature";
import type { PendingJobAction } from "@/features/processing/use-processing-tasks";
import type {
  AudioSummary,
  AudioWorkspaceSnapshot,
  CapturePreflight,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "@shared/contracts";

type AudioRouteOptions = {
  api: Voice2TextDesktopApi;
  tasks: readonly ProcessingTask[];
  pendingJobActions: ReadonlyMap<number, PendingJobAction>;
  writable: boolean;
  processingAvailable?: boolean;
  recordingActive?: boolean;
  newRecordingBlocked?: boolean;
  active?: boolean;
  enabled?: boolean;
  onAudioSelected?: () => void;
  onRecord: (microphoneDeviceId?: string) => void;
  onImport: () => void | Promise<void>;
  onProcessingUnavailable?: (reason?: string) => void;
  onCancel: (jobId: number) => void | Promise<void>;
  onRetry: (jobId: number, attempt: number) => void | Promise<void>;
};

export type AudioRouteController = ReturnType<typeof useAudioRouteController>;

// Route-local state is intentionally colocated with the two route surfaces.
// eslint-disable-next-line react-refresh/only-export-components
export function useAudioRouteController({
  api,
  tasks,
  pendingJobActions,
  writable,
  processingAvailable = true,
  recordingActive = false,
  newRecordingBlocked = false,
  active = true,
  enabled = true,
  onAudioSelected,
  onRecord,
  onImport,
  onProcessingUnavailable,
  onCancel,
  onRetry,
}: AudioRouteOptions) {
  const [audios, setAudios] = React.useState<AudioSummary[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [listError, setListError] = React.useState<string | null>(null);
  const [listPending, setListPending] = React.useState(true);
  const [workspace, setWorkspaceState] =
    React.useState<AudioWorkspaceSnapshot | null>(null);
  const [transitionError, setTransitionError] = React.useState<string | null>(
    null,
  );
  const [transitionPending, setTransitionPending] = React.useState(false);
  const [importPending, setImportPending] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [capturePreflight, setCapturePreflight] =
    React.useState<CapturePreflight | null>(null);
  const [capturePreflightPending, setCapturePreflightPending] =
    React.useState(false);
  const workspaceRef = React.useRef(workspace);
  const capturePreflightIntentRef = React.useRef(0);
  const listIntentRef = React.useRef(0);
  const selectionIntentRef = React.useRef(0);
  const transitionCountRef = React.useRef(0);
  const importPendingRef = React.useRef(false);
  const closeRef = React.useRef<{
    audioId: number;
    promise: Promise<void>;
  } | null>(null);
  const activeRef = React.useRef(active);
  const taskStructureToken = React.useMemo(
    () =>
      tasks
        .map(
          (task) => `${task.id}:${task.audioId}:${task.attempt}:${task.state}`,
        )
        .sort()
        .join("|"),
    [tasks],
  );
  const previousTaskStructureRef = React.useRef(taskStructureToken);
  const tasksByAudioId = React.useMemo(
    () => groupTasksByAudioId(tasks),
    [tasks],
  );
  const previousCurrentTasksRef = React.useRef(
    currentTasksByAudioId(tasksByAudioId),
  );

  const setWorkspace = React.useCallback((next: AudioWorkspaceSnapshot) => {
    const current = workspaceRef.current;
    if (
      !current ||
      current.summary.audioId !== next.summary.audioId ||
      next.revision < current.revision
    ) {
      return;
    }
    workspaceRef.current = next;
    setWorkspaceState(next);
  }, []);

  const requestPlaybackClose = React.useCallback(
    (audioId: number) => {
      if (closeRef.current?.audioId === audioId)
        return closeRef.current.promise;
      const promise = Promise.resolve(
        api.controlAudioPlayback(audioId, { action: "close" }),
      ).then(() => undefined);
      closeRef.current = { audioId, promise };
      void promise.then(
        () => {
          if (closeRef.current?.promise === promise) closeRef.current = null;
        },
        () => {
          if (closeRef.current?.promise === promise) closeRef.current = null;
        },
      );
      return promise;
    },
    [api],
  );

  const clearRemovedSelection = React.useCallback(
    async (nextAudios: readonly AudioSummary[]) => {
      const current = workspaceRef.current;
      if (
        !current ||
        nextAudios.some((item) => item.audioId === current.summary.audioId)
      ) {
        return;
      }
      selectionIntentRef.current += 1;
      try {
        await requestPlaybackClose(current.summary.audioId);
      } catch (cause) {
        setTransitionError(
          errorMessage(cause, "音频已移除，但播放资源未能正常关闭"),
        );
      }
      workspaceRef.current = null;
      setWorkspaceState(null);
      closeRef.current = null;
    },
    [requestPlaybackClose],
  );

  const loadAudios = React.useCallback(async () => {
    const intent = ++listIntentRef.current;
    setListPending(true);
    setListError(null);
    try {
      const next = await api.listAudios();
      if (intent !== listIntentRef.current) return;
      setAudios(next);
      await clearRemovedSelection(next);
    } catch (cause) {
      if (intent === listIntentRef.current) {
        setListError(errorMessage(cause, "无法载入音频列表"));
      }
    } finally {
      if (intent === listIntentRef.current) setListPending(false);
    }
  }, [api, clearRemovedSelection]);

  React.useEffect(() => {
    if (!enabled) return;
    void Promise.resolve().then(loadAudios);
  }, [enabled, loadAudios]);

  React.useEffect(() => {
    if (!enabled) {
      previousTaskStructureRef.current = taskStructureToken;
      return;
    }
    if (previousTaskStructureRef.current === taskStructureToken) return;
    previousTaskStructureRef.current = taskStructureToken;
    void loadAudios();
  }, [enabled, loadAudios, taskStructureToken]);

  React.useEffect(() => {
    const currentTasks = currentTasksByAudioId(tasksByAudioId);
    const previousTasks = previousCurrentTasksRef.current;
    previousCurrentTasksRef.current = currentTasks;
    const selectedAudioId = workspaceRef.current?.summary.audioId;
    if (!enabled || !selectedAudioId) return;
    const current = currentTasks.get(selectedAudioId);
    const previous = previousTasks.get(selectedAudioId);
    if (
      current?.state !== "completed" ||
      !previous ||
      (previous.id === current.id &&
        previous.attempt === current.attempt &&
        previous.state === "completed")
    ) {
      return;
    }
    const selectionIntent = selectionIntentRef.current;
    void api
      .openAudio(selectedAudioId)
      .then((next) => {
        if (
          !next ||
          selectionIntent !== selectionIntentRef.current ||
          workspaceRef.current?.summary.audioId !== selectedAudioId
        ) {
          return;
        }
        setWorkspace(next);
      })
      .catch((cause: unknown) => {
        if (selectionIntent === selectionIntentRef.current) {
          setTransitionError(errorMessage(cause, "处理完成后无法刷新音频转写"));
        }
      });
  }, [api, enabled, setWorkspace, tasksByAudioId]);

  React.useEffect(
    () => () => {
      selectionIntentRef.current += 1;
      const current = workspaceRef.current;
      if (current)
        void requestPlaybackClose(current.summary.audioId).catch(
          () => undefined,
        );
    },
    [requestPlaybackClose],
  );

  React.useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    const current = workspaceRef.current;
    if (wasActive && !active && current) {
      void requestPlaybackClose(current.summary.audioId).catch((cause) => {
        setTransitionError(errorMessage(cause, "离开音频工作区时无法关闭播放"));
      });
    } else if (!wasActive && active) {
      closeRef.current = null;
    }
  }, [active, requestPlaybackClose]);

  const selectAudio = React.useCallback(
    async (audioId: number) => {
      const current = workspaceRef.current;
      if (current?.summary.audioId === audioId) {
        setTransitionError(null);
        onAudioSelected?.();
        return;
      }
      const intent = ++selectionIntentRef.current;
      transitionCountRef.current += 1;
      setTransitionPending(true);
      setTransitionError(null);
      try {
        if (current) await requestPlaybackClose(current.summary.audioId);
        if (intent !== selectionIntentRef.current) return;
        const next = await api.openAudio(audioId);
        if (intent !== selectionIntentRef.current) return;
        if (!next) throw new Error("音频不存在或已被移除");
        workspaceRef.current = next;
        setWorkspaceState(next);
        closeRef.current = null;
        onAudioSelected?.();
      } catch (cause) {
        if (intent === selectionIntentRef.current) {
          setTransitionError(errorMessage(cause, "无法打开音频"));
        }
      } finally {
        transitionCountRef.current = Math.max(
          0,
          transitionCountRef.current - 1,
        );
        if (
          intent === selectionIntentRef.current ||
          transitionCountRef.current === 0
        ) {
          setTransitionPending(false);
        }
      }
    },
    [api, onAudioSelected, requestPlaybackClose],
  );

  const importAudio = React.useCallback(async () => {
    if (!writable || importPendingRef.current) return;
    importPendingRef.current = true;
    setImportPending(true);
    setImportError(null);
    try {
      await onImport();
    } catch (cause) {
      setImportError(errorMessage(cause, "导入音频失败"));
    } finally {
      importPendingRef.current = false;
      setImportPending(false);
    }
  }, [onImport, writable]);

  const retryProcessing = React.useCallback(
    (jobId: number, attempt: number) => {
      if (!processingAvailable) {
        onProcessingUnavailable?.();
        return;
      }
      return onRetry(jobId, attempt);
    },
    [onProcessingUnavailable, onRetry, processingAvailable],
  );

  const startTranscription = React.useCallback(async () => {
    const audioId = workspaceRef.current?.summary.audioId;
    if (!audioId || transitionPending) return;
    if (!processingAvailable) {
      onProcessingUnavailable?.();
      return;
    }
    setTransitionPending(true);
    setTransitionError(null);
    try {
      await api.startTranscription(audioId);
    } catch (cause) {
      const message = errorMessage(cause, "无法开始本地转写");
      if (/模型|runtime|storage|本地转写不可用/i.test(message)) {
        onProcessingUnavailable?.(message);
      } else {
        setTransitionError(message);
      }
    } finally {
      setTransitionPending(false);
    }
  }, [api, onProcessingUnavailable, processingAvailable, transitionPending]);

  const refreshCapturePreflight = React.useCallback(
    async (requestPermissions: boolean) => {
      const intent = ++capturePreflightIntentRef.current;
      setCapturePreflightPending(true);
      try {
        const next = await api.preflightCapture({
          requestPermissions,
          captionEnabled: false,
        });
        if (intent === capturePreflightIntentRef.current) {
          setCapturePreflight(next);
        }
        return next;
      } finally {
        if (intent === capturePreflightIntentRef.current) {
          setCapturePreflightPending(false);
        }
      }
    },
    [api],
  );
  const acceptCapturePreflight = React.useCallback((next: CapturePreflight) => {
    capturePreflightIntentRef.current += 1;
    setCapturePreflight(next);
    setCapturePreflightPending(false);
  }, []);

  React.useEffect(() => {
    if (!enabled || !active) {
      capturePreflightIntentRef.current += 1;
      return;
    }
    void Promise.resolve()
      .then(() => refreshCapturePreflight(false))
      .catch(() => undefined);
    return () => {
      capturePreflightIntentRef.current += 1;
    };
  }, [active, enabled, refreshCapturePreflight]);

  const captureReadyWithMicrophone = Boolean(
    writable &&
    capturePreflight?.canStart &&
    capturePreflight.microphones.length > 0,
  );

  const filteredAudios = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return audios ?? [];
    return (audios ?? []).filter((audio) =>
      audio.displayName.toLocaleLowerCase().includes(normalized),
    );
  }, [audios, query]);
  return {
    api,
    audios,
    filteredAudios,
    query,
    setQuery,
    listError,
    listPending,
    reload: loadAudios,
    workspace,
    setWorkspace,
    selectAudio,
    transitionError,
    transitionPending,
    importPending,
    importError,
    importAudio,
    record: onRecord,
    recordingActive,
    newRecordingBlocked,
    capturePreflight,
    capturePreflightPending,
    refreshCapturePreflight,
    acceptCapturePreflight,
    captureReadyWithMicrophone,
    writable,
    tasks,
    tasksByAudioId,
    pendingJobActions,
    onCancel,
    onRetry: retryProcessing,
    startTranscription,
  };
}

export function AudioRouteFeature({
  paneOpen,
  ...options
}: AudioRouteOptions & { paneOpen: boolean }) {
  const controller = useAudioRouteController(options);
  return (
    <div className="contents">
      {paneOpen ? (
        <section
          role="region"
          aria-label="音频列表"
          className="flex h-full min-h-0 flex-col"
        >
          <div className="min-h-0 flex-1">
            <AudioContextPane controller={controller} />
          </div>
          {controller.workspace !== null ? (
            <div
              data-context-pane-fixed-footer="true"
              className="shrink-0 border-t p-2"
            >
              <AudioContextPaneHeader controller={controller} />
            </div>
          ) : null}
        </section>
      ) : null}
      <section role="region" aria-label="音频工作区">
        <AudioMainWorkspace controller={controller} />
      </section>
    </div>
  );
}

export function AudioContextPaneHeader({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return (
    <div role="group" aria-label="录音操作">
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={
          !controller.captureReadyWithMicrophone ||
          controller.recordingActive ||
          controller.newRecordingBlocked ||
          controller.capturePreflightPending
        }
        onClick={() => controller.record()}
      >
        <Mic aria-hidden="true" />
        {controller.recordingActive ? "正在录音" : "新录音"}
      </Button>
    </div>
  );
}

export function AudioContextPane({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return (
    <SidebarGroup className="h-full p-0">
      <SidebarGroupContent className="flex h-full flex-col">
        <h3 className="sr-only">音频列表</h3>
        <div className="flex shrink-0 items-center gap-2 p-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            />
            <SidebarInput
              type="search"
              aria-label="搜索音频"
              value={controller.query}
              onChange={(event) =>
                controller.setQuery(event.currentTarget.value)
              }
              className="pl-8"
            />
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="导入音频"
                  aria-busy={controller.importPending}
                  disabled={!controller.writable || controller.importPending}
                  onClick={() => void controller.importAudio()}
                >
                  <FileInput aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">导入音频</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {controller.importError ? (
          <p role="alert" className="border-b px-3 py-2 text-sm">
            {controller.importError}
          </p>
        ) : null}
        {controller.listError ? (
          <div role="alert" className="space-y-2 border-b p-3 text-sm">
            <p>{controller.listError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void controller.reload()}
            >
              <RotateCcw aria-hidden="true" />
              重新载入
            </Button>
          </div>
        ) : controller.listPending && controller.audios === null ? (
          <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto_3fr]">
            <div
              role="status"
              aria-label="正在载入音频列表"
              className="row-start-2 flex items-center justify-center gap-2 px-3 py-4 text-sm"
            >
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              正在载入音频列表
            </div>
          </div>
        ) : controller.filteredAudios.length === 0 ? (
          <EmptyState
            title={controller.query.trim() ? "没有匹配的音频" : "还没有音频"}
            compact
            className="min-h-0 flex-1"
          />
        ) : (
          <ul
            aria-label="音频列表"
            data-flat-row-list="true"
            className="divide-y divide-sidebar-border border-b border-sidebar-border"
          >
            {controller.filteredAudios.map((audio) => {
              const task = selectCurrentTask(
                controller.tasksByAudioId.get(audio.audioId),
              );
              const state = processingStateForRow(audio, task);
              const selected =
                controller.workspace?.summary.audioId === audio.audioId;
              return (
                <li key={audio.audioId}>
                  <Item
                    asChild
                    size="sm"
                    className="w-full rounded-none border-0 px-3 text-left hover:bg-sidebar-accent aria-current:bg-muted"
                  >
                    <button
                      type="button"
                      data-audio-id={audio.audioId}
                      data-flat-row="true"
                      aria-label={`打开 ${audio.displayName}`}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => void controller.selectAudio(audio.audioId)}
                    >
                      <ItemContent>
                        <ItemTitle className="max-w-full truncate">
                          {audio.displayName}
                        </ItemTitle>
                        <ItemDescription>
                          {audio.segmentCount} 个片段
                        </ItemDescription>
                        {state ? (
                          <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
                            <ProcessingIcon state={state} />
                            {taskStateLabel(state)}
                          </span>
                        ) : null}
                      </ItemContent>
                    </button>
                  </Item>
                </li>
              );
            })}
          </ul>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AudioMainWorkspace({
  controller,
  operationError,
  showRecordingReady = true,
}: {
  controller: AudioRouteController;
  operationError?: string | null;
  showRecordingReady?: boolean;
}) {
  const workspace = controller.workspace;
  const task = workspace
    ? selectCurrentTask(
        controller.tasksByAudioId.get(workspace.summary.audioId),
      )
    : null;
  return (
    <div className="flex min-h-full flex-col gap-4">
      <ProcessingLiveStatus tasks={controller.tasks} />
      {operationError ? <AudioOperationError message={operationError} /> : null}
      {controller.transitionError ? (
        <AudioOperationError message={controller.transitionError} />
      ) : null}
      {!workspace && showRecordingReady ? (
        <RecordingReadyState controller={controller} />
      ) : workspace ? (
        <div key={workspace.summary.audioId} className="space-y-4">
          {!task && workspace.segments.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-y py-3">
              <div>
                <p className="text-sm font-medium">尚未转写</p>
                <p className="text-xs text-muted-foreground">
                  音频已安全保存，需要时再使用本地模型转写。
                </p>
              </div>
              <Button
                type="button"
                disabled={controller.transitionPending}
                onClick={() => void controller.startTranscription()}
              >
                开始转写
              </Button>
            </div>
          ) : null}
          {task &&
          !(task.state === "completed" && workspace.segments.length > 0) ? (
            <AudioProcessingDetail
              task={task}
              pendingAction={controller.pendingJobActions.get(task.id)}
              onCancel={controller.onCancel}
              onRetry={controller.onRetry}
            />
          ) : null}
          <AudioDetailWorkspace
            api={controller.api}
            workspace={workspace}
            routePending={controller.transitionPending}
            onWorkspaceChange={controller.setWorkspace}
          />
        </div>
      ) : null}
    </div>
  );
}

function RecordingReadyState({
  controller,
}: {
  controller: AudioRouteController;
}) {
  const { capturePreflight: preflight, refreshCapturePreflight } = controller;
  const [selectedMicrophoneDeviceId, setSelectedMicrophoneDeviceId] =
    React.useState("");
  const [testPhase, setTestPhase] = React.useState<
    "closed" | "instructions" | "starting" | "testing" | "failure"
  >("closed");
  const [testSnapshot, setTestSnapshot] = React.useState<
    import("@shared/contracts").MicrophoneTestSnapshot | null
  >(null);
  const [failureReason, setFailureReason] = React.useState<
    import("@shared/contracts").MicrophoneTestSnapshot["reason"] | null
  >(null);
  const [finishPending, setFinishPending] = React.useState(false);
  const [teardownPending, setTeardownPending] = React.useState(false);
  const [settingsManualPathVisible, setSettingsManualPathVisible] =
    React.useState(false);
  const activeTestIdRef = React.useRef<string | null>(null);
  const generationRef = React.useRef(0);
  const microphoneDeviceId =
    selectPreferredMicrophone(
      preflight?.microphones ?? [],
      selectedMicrophoneDeviceId,
    )?.id ?? "";

  const showFailure = React.useCallback(
    (
      reason: NonNullable<
        import("@shared/contracts").MicrophoneTestSnapshot["reason"]
      >,
    ) => {
      activeTestIdRef.current = null;
      setFailureReason(reason);
      setTestPhase("failure");
    },
    [],
  );

  const cancelActiveTest = React.useCallback(async () => {
    const testId = activeTestIdRef.current;
    activeTestIdRef.current = null;
    if (!testId) return;
    setTeardownPending(true);
    try {
      await controller.api.cancelMicrophoneTest(testId);
    } catch {
      // Closing is an explicit cancellation path and never presents a result.
    } finally {
      setTeardownPending(false);
    }
  }, [controller.api]);

  const closeTest = React.useCallback(() => {
    generationRef.current += 1;
    if (testPhase === "starting") setTeardownPending(true);
    setTestPhase("closed");
    setTestSnapshot(null);
    setFailureReason(null);
    setSettingsManualPathVisible(false);
    void cancelActiveTest();
  }, [cancelActiveTest, testPhase]);

  const finishTest = React.useCallback(async () => {
    const testId = activeTestIdRef.current;
    if (!testId || finishPending) return;
    const generation = generationRef.current;
    setFinishPending(true);
    try {
      const finished = await controller.api.finishMicrophoneTest(testId);
      if (generation !== generationRef.current) return;
      activeTestIdRef.current = null;
      setTestSnapshot(finished);
      if (finished.reason === "detected" || finished.observedSound) {
        setTestPhase("closed");
        setFailureReason(null);
      } else {
        showFailure(finished.reason ?? "snapshot-failed");
      }
    } catch {
      if (generation === generationRef.current) {
        showFailure("native-helper-failed");
      }
    } finally {
      setFinishPending(false);
    }
  }, [controller.api, finishPending, showFailure]);

  const startTest = React.useCallback(
    async (selectedDeviceId: string) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setTestPhase("starting");
      setTestSnapshot(null);
      setFailureReason(null);
      setSettingsManualPathVisible(false);
      try {
        const next = await refreshCapturePreflight(true);
        if (generation !== generationRef.current) return;
        const preferred = selectPreferredMicrophone(
          next.microphones,
          selectedDeviceId,
        );
        setSelectedMicrophoneDeviceId(preferred?.id ?? "");
        if (next.microphonePermission !== "granted") {
          showFailure("permission-denied");
          return;
        }
        if (!preferred) {
          showFailure("device-unavailable");
          return;
        }
        const started = await controller.api.startMicrophoneTest({
          microphoneDeviceId: preferred.id,
        });
        if (generation !== generationRef.current) {
          await controller.api.cancelMicrophoneTest(started.testId);
          return;
        }
        activeTestIdRef.current = started.testId;
        setTestSnapshot(started);
        if (started.state === "running") {
          setTestPhase("testing");
        } else if (started.state === "failed") {
          showFailure(started.reason ?? "native-helper-failed");
        }
      } catch {
        if (generation === generationRef.current) {
          showFailure("native-helper-failed");
        }
      } finally {
        if (generation !== generationRef.current) {
          setTeardownPending(false);
        }
      }
    },
    [controller.api, refreshCapturePreflight, showFailure],
  );

  React.useEffect(() => {
    if (testPhase !== "testing" || !testSnapshot?.testId) return;
    let active = true;
    const generation = generationRef.current;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await controller.api.getMicrophoneTestSnapshot(
          testSnapshot.testId,
        );
        if (!active || generation !== generationRef.current) return;
        setTestSnapshot(next);
        if (next.state === "running") {
          timer = window.setTimeout(() => void poll(), 50);
        } else if (next.state === "failed") {
          activeTestIdRef.current = null;
          showFailure(next.reason ?? "snapshot-failed");
        }
      } catch {
        if (!active || generation !== generationRef.current) return;
        activeTestIdRef.current = null;
        showFailure("snapshot-failed");
      }
    };
    timer = window.setTimeout(() => void poll(), 50);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [controller.api, showFailure, testPhase, testSnapshot?.testId]);

  React.useEffect(() => {
    return () => {
      generationRef.current += 1;
      void cancelActiveTest();
    };
  }, [cancelActiveTest]);

  const openMicrophoneSettings = React.useCallback(async () => {
    try {
      const result = await controller.api.openMicrophoneSettings();
      setSettingsManualPathVisible(result.state === "failed");
    } catch {
      setSettingsManualPathVisible(true);
    }
  }, [controller.api]);

  const testBusy = testPhase === "starting" || testPhase === "testing";

  return (
    <section
      aria-label="录制准备"
      aria-busy={
        testBusy ||
        controller.capturePreflightPending ||
        controller.transitionPending
      }
      className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center"
    >
      <div className="space-y-2">
        <Label htmlFor="ready-microphone">麦克风</Label>
        <Select
          value={microphoneDeviceId}
          disabled={
            testBusy || teardownPending || !preflight?.microphones.length
          }
          onValueChange={setSelectedMicrophoneDeviceId}
        >
          <SelectTrigger id="ready-microphone" className="w-full">
            <SelectValue
              placeholder={testBusy ? "正在检测设备" : "没有可用设备"}
            />
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
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Button
          type="button"
          variant="outline"
          className="col-span-1"
          disabled={
            testBusy ||
            teardownPending ||
            controller.capturePreflightPending ||
            controller.recordingActive
          }
          onClick={() => setTestPhase("instructions")}
        >
          测试麦克风
        </Button>
        <Button
          type="button"
          className="col-span-2"
          disabled={
            !controller.captureReadyWithMicrophone ||
            !microphoneDeviceId ||
            testBusy ||
            teardownPending
          }
          onClick={() => controller.record(microphoneDeviceId || undefined)}
        >
          <Mic aria-hidden="true" />
          开始录制
        </Button>
      </div>
      <Dialog
        open={testPhase !== "closed"}
        onOpenChange={(open) => {
          if (!open) closeTest();
        }}
      >
        <DialogContent
          showCloseButton={
            testPhase !== "failure" || failureReason !== "native-helper-failed"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {testPhase === "instructions"
                ? "测试麦克风"
                : testPhase === "starting" || testPhase === "testing"
                  ? "正在测试麦克风"
                  : microphoneFailureTitle(failureReason)}
            </DialogTitle>
            <DialogDescription>
              {testPhase === "instructions"
                ? "开始后，请对着麦克风说话。"
                : testPhase === "starting"
                  ? "正在连接麦克风…"
                  : testPhase === "testing"
                    ? testSnapshot?.observedSound
                      ? "已收到声音"
                      : "暂未收到声音"
                    : microphoneFailureDescription(failureReason)}
            </DialogDescription>
          </DialogHeader>
          {testPhase === "instructions" ? (
            <div className="flex justify-end gap-2 pt-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  取消
                </Button>
              </DialogClose>
              <Button
                type="button"
                onClick={() => void startTest(microphoneDeviceId)}
              >
                开始测试
              </Button>
            </div>
          ) : testPhase === "starting" ? (
            <div className="flex justify-end pt-2">
              <Button type="button" variant="outline" onClick={closeTest}>
                取消
              </Button>
            </div>
          ) : testPhase === "testing" ? (
            <div className="space-y-4 pt-2">
              <div
                role="meter"
                aria-label="麦克风输入音量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  (testSnapshot?.normalizedPeak ?? 0) * 100,
                )}
                aria-valuetext={`${Math.round((testSnapshot?.normalizedPeak ?? 0) * 100)}%`}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${(testSnapshot?.normalizedPeak ?? 0) * 100}%`,
                  }}
                />
              </div>
              <p role="status" aria-live="polite" className="text-sm">
                {testSnapshot?.observedSound ? "已收到声音" : "暂未收到声音"}
              </p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  autoFocus
                  disabled={finishPending}
                  onClick={() => void finishTest()}
                >
                  结束测试
                </Button>
              </div>
            </div>
          ) : testPhase === "failure" ? (
            <div className="space-y-3 pt-2">
              <div aria-live="assertive" className="sr-only">
                {microphoneFailureDescription(failureReason)}
              </div>
              {settingsManualPathVisible ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  请手动前往：系统设置 → 隐私与安全 → 麦克风
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                {failureReason !== "native-helper-failed" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openMicrophoneSettings()}
                  >
                    前往麦克风设置
                  </Button>
                ) : null}
                <Button type="button" onClick={closeTest}>
                  知道了
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function selectPreferredMicrophone<
  T extends { id: string; isDefault: boolean },
>(microphones: readonly T[], preferredDeviceId?: string | null): T | undefined {
  return (
    microphones.find((device) => device.id === preferredDeviceId) ??
    microphones.find((device) => device.isDefault) ??
    microphones[0]
  );
}

function microphoneFailureTitle(
  reason: import("@shared/contracts").MicrophoneTestSnapshot["reason"] | null,
): string {
  return reason === "no-audio-frames" || reason === "no-sound-observed"
    ? "未检测到麦克风输入"
    : reason === "device-unavailable"
      ? "麦克风不可用"
      : "麦克风测试失败";
}

function microphoneFailureDescription(
  reason: import("@shared/contracts").MicrophoneTestSnapshot["reason"] | null,
): string {
  switch (reason) {
    case "no-audio-frames":
    case "no-sound-observed":
      return "未检测到麦克风输入";
    case "permission-denied":
      return "没有麦克风权限，请在系统设置中允许访问。";
    case "device-unavailable":
      return "麦克风不可用，请检查设备连接。";
    case "device-open-failed":
      return "无法打开麦克风，请检查设备是否被其他应用占用。";
    case "unsupported-format":
      return "当前麦克风格式不受支持，请选择其他设备。";
    case "native-helper-failed":
      return "麦克风测试暂不可用，请重启应用。";
    case "snapshot-failed":
    default:
      return "麦克风测试出现问题，请重新测试";
  }
}

function AudioProcessingDetail({
  task,
  pendingAction,
  onCancel,
  onRetry,
}: {
  task: ProcessingTask;
  pendingAction: PendingJobAction | undefined;
  onCancel: (jobId: number) => void | Promise<void>;
  onRetry: (jobId: number, attempt: number) => void | Promise<void>;
}) {
  const retryable = task.state === "failed" || task.state === "interrupted";
  const cancelable = task.state === "running";
  return (
    <section
      aria-label="当前音频处理"
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{taskStateLabel(task.state)}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {phaseLabel(task.phase)} · 第 {Math.max(1, task.attempt)} 次尝试
          </p>
        </div>
        {cancelable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pendingAction !== undefined}
            aria-label={`${pendingAction === "cancel" ? "正在取消" : "取消"} ${task.displayName}`}
            onClick={() => void onCancel(task.id)}
          >
            <Square aria-hidden="true" />
            {pendingAction === "cancel" ? "正在取消" : "取消"}
          </Button>
        ) : retryable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pendingAction !== undefined}
            aria-label={`${pendingAction === "retry" ? "正在重试" : "重试"} ${task.displayName}`}
            onClick={() => void onRetry(task.id, task.attempt)}
          >
            <RotateCcw aria-hidden="true" />
            {pendingAction === "retry" ? "正在重试" : "重试"}
          </Button>
        ) : null}
      </div>
      <Progress
        className="mt-4"
        data-processing-job-id={task.id}
        max={1}
        value={task.progressFraction}
        aria-label={`${task.displayName} 处理进度`}
      />
      <p className="mt-2 text-sm">{Math.round(task.progressFraction * 100)}%</p>
      {task.errorCode ? (
        <p className="mt-2 text-sm text-destructive">
          错误代码：{task.errorCode}
        </p>
      ) : null}
    </section>
  );
}

function ProcessingLiveStatus({ tasks }: { tasks: readonly ProcessingTask[] }) {
  const announcement = useThrottledAnnouncement(tasks);
  return (
    <p
      role="status"
      aria-label="音频处理进度公告"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </p>
  );
}

function useThrottledAnnouncement(tasks: readonly ProcessingTask[]): string {
  const previousTasks = React.useRef(tasks);
  const [current, setCurrent] = React.useState(() => announce(tasks, tasks));
  const currentRef = React.useRef(current);
  const lastUpdate = React.useRef(0);
  React.useEffect(() => {
    const next = announce(tasks, previousTasks.current);
    previousTasks.current = tasks;
    if (next === currentRef.current) return;
    const delay = Math.max(0, 750 - (Date.now() - lastUpdate.current));
    const timer = window.setTimeout(() => {
      lastUpdate.current = Date.now();
      currentRef.current = next;
      setCurrent(next);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [tasks]);
  return current;
}

function announce(
  tasks: readonly ProcessingTask[],
  previousTasks: readonly ProcessingTask[],
): string {
  const task = tasks.find(
    (candidate) =>
      candidate.state === "running" || candidate.state === "canceling",
  );
  if (task) {
    return `${task.displayName} ${task.state === "canceling" ? "正在取消" : phaseLabel(task.phase)} ${Math.round(task.progressFraction * 100)}%`;
  }
  const terminal = tasks.find((candidate) => {
    if (
      !["completed", "failed", "canceled", "interrupted"].includes(
        candidate.state,
      )
    )
      return false;
    const previous = previousTasks.find(
      (item) => item.id === candidate.id && item.attempt === candidate.attempt,
    );
    return previous?.state !== candidate.state;
  });
  return terminal
    ? `${terminal.displayName} ${taskStateLabel(terminal.state)}`
    : "当前没有正在运行的音频处理";
}

function groupTasksByAudioId(tasks: readonly ProcessingTask[]) {
  const grouped = new Map<number, ProcessingTask[]>();
  for (const task of tasks) {
    const values = grouped.get(task.audioId) ?? [];
    values.push(task);
    grouped.set(task.audioId, values);
  }
  return grouped;
}

function selectCurrentTask(
  tasks: readonly ProcessingTask[] | undefined,
): ProcessingTask | null {
  return tasks
    ? ([...tasks].sort(
        (left, right) => right.id - left.id || right.attempt - left.attempt,
      )[0] ?? null)
    : null;
}

function currentTasksByAudioId(
  grouped: ReadonlyMap<number, readonly ProcessingTask[]>,
): Map<number, ProcessingTask> {
  const current = new Map<number, ProcessingTask>();
  for (const [audioId, tasks] of grouped) {
    const task = selectCurrentTask(tasks);
    if (task) current.set(audioId, task);
  }
  return current;
}

function processingStateForRow(
  audio: AudioSummary,
  task: ProcessingTask | null,
): ProcessingTask["state"] | null {
  const state = task?.state ?? audio.processingState;
  if (
    state === "not-started" ||
    state === "completed" ||
    state === "partial-success"
  )
    return null;
  return state;
}

function ProcessingIcon({ state }: { state: ProcessingTask["state"] }) {
  const Icon = {
    queued: Clock3,
    running: LoaderCircle,
    canceling: LoaderCircle,
    canceled: Ban,
    interrupted: CircleAlert,
    completed: Clock3,
    failed: CircleAlert,
  }[state];
  return (
    <Icon
      className={
        state === "running" || state === "canceling"
          ? "size-3.5 animate-spin"
          : "size-3.5"
      }
      aria-hidden="true"
    />
  );
}

function taskStateLabel(state: ProcessingTask["state"]): string {
  return {
    queued: "等待处理",
    running: "正在处理",
    canceling: "正在取消",
    canceled: "已取消",
    interrupted: "已中断",
    completed: "已完成",
    failed: "处理失败",
  }[state];
}

function phaseLabel(phase: ProcessingTask["phase"]): string {
  return phase === "asr" ? "正在识别" : "正在区分说话人";
}

function AudioOperationError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border bg-card px-4 py-3 text-sm">
      操作未完成：{message}
    </div>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
