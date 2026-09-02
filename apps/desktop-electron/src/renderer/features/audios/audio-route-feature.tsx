import * as React from "react";
import {
  AudioLines,
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarInput,
} from "@/components/ui/sidebar";
import { AudioDetailWorkspace } from "@/features/audios/audio-workspace-feature";
import {
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "@/features/capture/use-recording-preference";
import type { PendingJobAction } from "@/features/processing/use-processing-tasks";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  AudioSummary,
  AudioWorkspaceSnapshot,
  CapturePreflight,
  ImportAudioResponse,
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
  libraryRefreshToken?: string;
  recordingCompletionToken?: string | null;
  active?: boolean;
  enabled?: boolean;
  onAudioSelected?: (audioId: number) => void;
  onRecord: () => void;
  onImport: () => Promise<ImportAudioResponse | undefined>;
  onProcessingUnavailable?: (reason?: string) => void;
  onCancel: (jobId: number) => void | Promise<void>;
  onRetry: (jobId: number, attempt: number) => void | Promise<void>;
};

type AudioFilter = "all" | "attention" | "processing" | "completed";

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
  libraryRefreshToken,
  recordingCompletionToken = null,
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
  const [filter, setFilter] = React.useState<AudioFilter>("all");
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
  const [capturePreflightError, setCapturePreflightError] = React.useState<
    string | null
  >(null);
  const workspaceRef = React.useRef(workspace);
  const capturePreflightIntentRef = React.useRef(0);
  const listIntentRef = React.useRef(0);
  const listRequestRef = React.useRef<Promise<void> | null>(null);
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
  const previousRefreshSignalsRef = React.useRef({
    library: libraryRefreshToken,
    recording: recordingCompletionToken,
  });
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
          userFacingError(cause, "音频已移除，但播放未能关闭"),
        );
      }
      workspaceRef.current = null;
      setWorkspaceState(null);
      closeRef.current = null;
    },
    [requestPlaybackClose],
  );

  const loadAudios = React.useCallback(() => {
    if (listRequestRef.current) return listRequestRef.current;
    const intent = ++listIntentRef.current;
    setListPending(true);
    setListError(null);
    const request = (async () => {
      try {
        const next = await api.listAudios();
        if (intent !== listIntentRef.current) return;
        await clearRemovedSelection(next);
        if (intent !== listIntentRef.current) return;
        setAudios(next);
      } catch (cause) {
        if (intent === listIntentRef.current) {
          setListError(userFacingError(cause, "无法载入音频列表"));
        }
      } finally {
        if (intent === listIntentRef.current) setListPending(false);
      }
    })();
    listRequestRef.current = request;
    return request.finally(() => {
      if (listRequestRef.current === request) listRequestRef.current = null;
    });
  }, [api, clearRemovedSelection]);

  const refreshAudios = React.useCallback(async () => {
    const activeRequest = listRequestRef.current;
    if (activeRequest) await activeRequest;
    await loadAudios();
  }, [loadAudios]);

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
    void refreshAudios();
  }, [enabled, refreshAudios, taskStructureToken]);

  React.useEffect(() => {
    const previous = previousRefreshSignalsRef.current;
    previousRefreshSignalsRef.current = {
      library: libraryRefreshToken,
      recording: recordingCompletionToken,
    };
    if (!enabled) return;
    const libraryChanged =
      libraryRefreshToken !== undefined &&
      previous.library !== undefined &&
      previous.library !== libraryRefreshToken;
    const recordingCompleted =
      recordingCompletionToken !== null &&
      recordingCompletionToken !== previous.recording;
    if (libraryChanged || recordingCompleted) void refreshAudios();
  }, [enabled, libraryRefreshToken, recordingCompletionToken, refreshAudios]);

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
          setTransitionError(
            userFacingError(cause, "处理完成后无法刷新音频转写"),
          );
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
      selectionIntentRef.current += 1;
      void requestPlaybackClose(current.summary.audioId).catch((cause) => {
        setTransitionError(
          userFacingError(cause, "离开音频工作区时无法关闭播放"),
        );
      });
    } else if (!wasActive && active) {
      closeRef.current = null;
    }
  }, [active, requestPlaybackClose]);

  const selectAudio = React.useCallback(
    async (audioId: number, options?: { fromRoute?: boolean }) => {
      const current = workspaceRef.current;
      if (current?.summary.audioId === audioId) {
        setTransitionError(null);
        if (!options?.fromRoute) onAudioSelected?.(audioId);
        return;
      }
      const intent = ++selectionIntentRef.current;
      transitionCountRef.current += 1;
      setTransitionPending(true);
      setTransitionError(null);
      try {
        if (current) {
          try {
            await requestPlaybackClose(current.summary.audioId);
          } catch (cause) {
            if (intent === selectionIntentRef.current) {
              setTransitionError(
                userFacingError(cause, "无法切换音频，请重试"),
              );
            }
            return;
          }
        }
        if (intent !== selectionIntentRef.current) return;
        const next = await api.openAudio(audioId);
        if (intent !== selectionIntentRef.current) return;
        if (!next) throw new Error("音频不存在或已被移除");
        workspaceRef.current = next;
        setWorkspaceState(next);
        closeRef.current = null;
        if (!options?.fromRoute) onAudioSelected?.(audioId);
      } catch (cause) {
        if (intent === selectionIntentRef.current) {
          setTransitionError(userFacingError(cause, "无法打开音频"));
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

  const clearSelection = React.useCallback(async () => {
    const current = workspaceRef.current;
    if (!current) return;
    const intent = ++selectionIntentRef.current;
    try {
      await requestPlaybackClose(current.summary.audioId);
    } catch (cause) {
      if (intent === selectionIntentRef.current) {
        setTransitionError(userFacingError(cause, "无法关闭音频播放"));
      }
      return;
    }
    if (intent !== selectionIntentRef.current) return;
    workspaceRef.current = null;
    setWorkspaceState(null);
    closeRef.current = null;
  }, [requestPlaybackClose]);

  const importAudio = React.useCallback(async () => {
    if (!writable || importPendingRef.current) return;
    importPendingRef.current = true;
    setImportPending(true);
    setImportError(null);
    try {
      const result = await onImport();
      if (!result || result.state === "canceled") return;
      await refreshAudios();
      await selectAudio(result.audioId);
    } catch (cause) {
      setImportError(userFacingError(cause, "无法导入音频，请重试。"));
    } finally {
      importPendingRef.current = false;
      setImportPending(false);
    }
  }, [onImport, refreshAudios, selectAudio, writable]);

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
      if (isProcessingUnavailableError(cause)) {
        onProcessingUnavailable?.();
      } else {
        setTransitionError(userFacingError(cause, "无法开始本地转写"));
      }
    } finally {
      setTransitionPending(false);
    }
  }, [api, onProcessingUnavailable, processingAvailable, transitionPending]);

  const refreshCapturePreflight = React.useCallback(
    async (requestPermissions: boolean) => {
      const intent = ++capturePreflightIntentRef.current;
      setCapturePreflightPending(true);
      setCapturePreflightError(null);
      try {
        const next = await api.preflightCapture({
          requestPermissions,
          captionEnabled: false,
        });
        if (intent === capturePreflightIntentRef.current) {
          setCapturePreflight(next);
        }
        return next;
      } catch (cause) {
        if (intent === capturePreflightIntentRef.current) {
          setCapturePreflightError(
            userFacingError(cause, "无法检查麦克风，请重试。"),
          );
        }
        throw cause;
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
    setCapturePreflightError(null);
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

  const filterCounts = React.useMemo(() => {
    const counts: Record<AudioFilter, number> = {
      all: audios?.length ?? 0,
      attention: 0,
      processing: 0,
      completed: 0,
    };
    for (const audio of audios ?? []) {
      const category = audioFilterFor(
        audio,
        selectCurrentTask(tasksByAudioId.get(audio.audioId)),
      );
      counts[category] += 1;
    }
    return counts;
  }, [audios, tasksByAudioId]);
  const filteredAudios = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (audios ?? []).filter((audio) => {
      const matchesQuery =
        !normalized ||
        audio.displayName.toLocaleLowerCase().includes(normalized);
      const matchesFilter =
        filter === "all" ||
        audioFilterFor(
          audio,
          selectCurrentTask(tasksByAudioId.get(audio.audioId)),
        ) === filter;
      return matchesQuery && matchesFilter;
    });
  }, [audios, filter, query, tasksByAudioId]);
  const libraryPresentation = !enabled
    ? "inactive"
    : audios === null || audios.length === 0
      ? listPending
        ? "loading"
        : listError
          ? "error"
          : "true-empty"
      : "populated";
  return {
    api,
    audios,
    filteredAudios,
    query,
    setQuery,
    filter,
    setFilter,
    filterCounts,
    listError,
    listPending,
    reload: loadAudios,
    workspace,
    setWorkspace,
    selectAudio,
    clearSelection,
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
    capturePreflightError,
    refreshCapturePreflight,
    acceptCapturePreflight,
    captureReadyWithMicrophone,
    libraryPresentation,
    writable,
    tasks,
    tasksByAudioId,
    pendingJobActions,
    onCancel,
    onRetry: retryProcessing,
    startTranscription,
  };
}

function isProcessingUnavailableError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /模型|runtime|storage|本地转写不可用/i.test(cause.message)
  );
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
          {controller.libraryPresentation === "populated" ? (
            <div className="flex h-[50px] shrink-0 items-center justify-between border-b px-3">
              <h2 className="text-sm font-semibold">音频</h2>
              {controller.workspace !== null ? (
                <AudioContextPaneHeader controller={controller} />
              ) : null}
            </div>
          ) : null}
          {controller.libraryPresentation === "populated" ? (
            <div
              data-context-pane-search="true"
              className="flex h-[45px] shrink-0 items-center border-b px-3 py-2"
            >
              <AudioContextPaneSearch controller={controller} />
            </div>
          ) : null}
          {controller.libraryPresentation === "populated" ? (
            <div className="shrink-0 border-b px-3 py-2">
              <AudioContextPaneFilters controller={controller} />
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <AudioContextPane controller={controller} />
          </div>
        </section>
      ) : null}
      <section role="region" aria-label="音频工作区">
        {controller.libraryPresentation === "populated" ? (
          <div className="flex h-12 items-center justify-end border-b px-4 py-2">
            <AudioMainHeaderActions controller={controller} />
          </div>
        ) : null}
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
        size="icon-sm"
        variant="ghost"
        className="size-7"
        aria-label={controller.recordingActive ? "正在录音" : "新录音"}
        disabled={
          !controller.captureReadyWithMicrophone ||
          controller.recordingActive ||
          controller.newRecordingBlocked ||
          controller.capturePreflightPending
        }
        onClick={() => controller.record()}
      >
        <Mic aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AudioContextPane({
  controller,
}: {
  controller: AudioRouteController;
}) {
  if (controller.libraryPresentation !== "populated") return null;
  return (
    <SidebarGroup className="h-full p-0">
      <SidebarGroupContent className="flex h-full flex-col">
        <h3 className="sr-only">音频列表</h3>
        {controller.listPending ? (
          <p
            role="status"
            className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
          >
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-hidden="true"
            />
            正在刷新音频…
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
        ) : null}
        {controller.filteredAudios.length === 0 ? (
          <EmptyState
            title="没有匹配的音频"
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
                        <ItemTitle className="max-w-full truncate text-sm font-semibold">
                          {audio.displayName}
                        </ItemTitle>
                        <ItemDescription className="text-xs leading-4">
                          <span className="block">
                            {formatAudioDate(audio.createdAtMs)} ·{" "}
                            {formatAudioDuration(audio.durationMs)}
                          </span>
                          <span className="block">
                            {audio.segmentCount} 个片段 ·{" "}
                            {audioProcessingLabel(audio, task)}
                          </span>
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

export function AudioContextPaneSearch({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return (
    <div className="relative min-w-0">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
      />
      <SidebarInput
        type="search"
        aria-label="搜索音频"
        value={controller.query}
        onChange={(event) => controller.setQuery(event.currentTarget.value)}
        className="h-7 rounded-md pl-8 text-xs md:text-xs"
      />
    </div>
  );
}

export function AudioContextPaneFilters({
  controller,
}: {
  controller: AudioRouteController;
}) {
  const filters: readonly { value: AudioFilter; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "attention", label: "需处理" },
    { value: "processing", label: "处理中" },
    { value: "completed", label: "已完成" },
  ];
  return (
    <div
      role="group"
      aria-label="音频筛选"
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      {filters.map((item) => (
        <Button
          key={item.value}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={controller.filter === item.value}
          className="h-6 rounded-md px-2 text-xs aria-pressed:bg-muted aria-pressed:font-medium"
          onClick={() => controller.setFilter(item.value)}
        >
          {item.label} {controller.filterCounts[item.value]}
        </Button>
      ))}
    </div>
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
      {controller.libraryPresentation !== "loading" &&
      controller.libraryPresentation !== "error" &&
      operationError ? (
        <AudioOperationError message={operationError} />
      ) : null}
      {controller.libraryPresentation !== "loading" &&
      controller.libraryPresentation !== "error" &&
      controller.transitionError ? (
        <AudioOperationError message={controller.transitionError} />
      ) : null}
      {controller.libraryPresentation === "loading" ? (
        <AudioLibraryLoading />
      ) : controller.libraryPresentation === "error" ? (
        <AudioLibraryError controller={controller} />
      ) : controller.libraryPresentation === "true-empty" &&
        showRecordingReady ? (
        <RecordingReadyState controller={controller} />
      ) : controller.libraryPresentation === "populated" && !workspace ? (
        <AudioSelectionPrompt />
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

function AudioLibraryLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载音频"
      className="flex min-h-72 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      正在加载音频…
    </div>
  );
}

function AudioLibraryError({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 text-center"
    >
      <p className="text-sm">{controller.listError}</p>
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
  );
}

export function AudioMainHeaderActions({
  controller,
}: {
  controller: AudioRouteController;
}) {
  if (controller.libraryPresentation !== "populated") return null;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AudioImportError controller={controller} />
      <AudioImportButton controller={controller} />
    </div>
  );
}

function AudioImportButton({
  controller,
  label = "导入音频",
  showIcon = true,
}: {
  controller: AudioRouteController;
  label?: string;
  showIcon?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-busy={controller.importPending}
      disabled={!controller.writable || controller.importPending}
      onClick={() => void controller.importAudio()}
    >
      {showIcon ? <FileInput aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}

function AudioImportError({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return controller.importError ? (
    <p role="alert" className="text-sm text-destructive">
      {controller.importError}
    </p>
  ) : null;
}

function AudioSelectionPrompt() {
  return (
    <EmptyState
      title="选择一段音频"
      description="从列表中选择一段音频。"
      icon={false}
      className="flex-1"
    />
  );
}

function AudioFirstUsePreview() {
  return (
    <div
      data-audio-first-use="preview"
      aria-hidden="true"
      className="-mr-10 -mb-30 ml-auto flex min-w-0 items-end bg-muted/10 px-6 pt-2 pb-0 sm:px-7 lg:absolute lg:top-[calc(50%-146px)] lg:right-0 lg:bottom-0 lg:left-[calc(50%+10px)] lg:m-0 lg:block lg:p-0"
    >
      <div
        data-audio-first-use="preview-surface"
        className="flex min-h-[350px] min-w-[450px] overflow-hidden rounded-tl-xl border-t border-l border-border/60 bg-background sm:min-h-[360px] lg:h-full lg:min-h-0 lg:w-full lg:min-w-0"
      />
    </div>
  );
}

function RecordingReadyState({
  controller,
}: {
  controller: AudioRouteController;
}) {
  const { capturePreflight: preflight } = controller;
  const recordingPreference = useRecordingPreference();
  const microphone = resolveRecordingMicrophone(
    preflight?.microphones ?? [],
    recordingPreference.microphoneDeviceId,
  );

  return (
    <section
      data-audio-first-use="frame"
      aria-label="首次使用音频"
      aria-busy={
        controller.capturePreflightPending || controller.transitionPending
      }
      className="relative mx-auto flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden"
    >
      <div
        data-audio-first-use="layout"
        className="mx-auto grid min-h-[440px] w-full max-w-4xl min-w-0 grid-cols-1 items-center lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        <div
          data-audio-first-use="content"
          className="flex min-w-0 items-center px-7 py-8 sm:px-9 sm:py-10 lg:pr-5"
        >
          <div className="flex w-full min-w-0 flex-1 flex-col items-start justify-center gap-6 p-6 text-left text-balance">
            <div className="flex max-w-md flex-col items-start gap-4 text-left">
              <span className="flex size-8 shrink-0 items-center justify-center self-start rounded-[10px] bg-muted text-foreground">
                <AudioLines className="size-4" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-2">
                <h2 className="text-xl leading-7 font-semibold tracking-tight sm:text-2xl sm:leading-8">
                  开始你的第一段音频
                </h2>
                <p className="max-w-md text-sm leading-5 text-muted-foreground">
                  <span className="block">录制一段新音频，或导入已有文件</span>
                  <span className="block">开始转写和整理。</span>
                </p>
              </div>
            </div>
            <div
              data-audio-first-use="actions"
              className="flex w-full min-w-0 items-center gap-2 max-[420px]:flex-wrap"
            >
              <Button
                type="button"
                disabled={
                  controller.capturePreflightPending ||
                  !controller.captureReadyWithMicrophone ||
                  !microphone ||
                  controller.recordingActive ||
                  controller.newRecordingBlocked
                }
                onClick={() => controller.record()}
              >
                {controller.capturePreflightPending ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Mic aria-hidden="true" />
                )}
                {controller.capturePreflightPending
                  ? "正在检查麦克风…"
                  : "开始录制"}
              </Button>
              <AudioImportButton
                controller={controller}
                label="导入外部音频"
                showIcon={false}
              />
            </div>
            {controller.importError || controller.capturePreflightError ? (
              <div className="min-w-0 space-y-2">
                <AudioImportError controller={controller} />
                {controller.capturePreflightError ? (
                  <div role="alert" className="space-y-2 text-sm">
                    <p>{controller.capturePreflightError}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void controller
                          .refreshCapturePreflight(true)
                          .catch(() => undefined)
                      }
                    >
                      <RotateCcw aria-hidden="true" />
                      重试
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <AudioFirstUsePreview />
      </div>
    </section>
  );
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
            {phaseLabel(task.phase)}
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
    </section>
  );
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

function audioFilterFor(
  audio: AudioSummary,
  task: ProcessingTask | null,
): Exclude<AudioFilter, "all"> {
  const state = task?.state ?? audio.processingState;
  if (state === "completed") return "completed";
  if (state === "queued" || state === "running" || state === "canceling") {
    return "processing";
  }
  return "attention";
}

function audioProcessingLabel(
  audio: AudioSummary,
  task: ProcessingTask | null,
): string {
  const state = task?.state ?? audio.processingState;
  if (state === "not-started") return "未转写";
  if (state === "partial-success") return "部分完成";
  return taskStateLabel(state);
}

const audioDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatAudioDate(value: number): string {
  return audioDateFormatter.format(value);
}

function formatAudioDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
