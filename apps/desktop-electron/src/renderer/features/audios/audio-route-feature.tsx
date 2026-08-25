import * as React from "react";
import {
  Ban,
  CircleAlert,
  Clock3,
  FileAudio,
  FileUp,
  LoaderCircle,
  Mic,
  RotateCcw,
  Search,
  SearchX,
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
                  <FileUp aria-hidden="true" />
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
          <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto_3fr]">
            <EmptyState
              icon={controller.query.trim() ? SearchX : FileAudio}
              title={controller.query.trim() ? "没有匹配的音频" : "还没有音频"}
              description={
                controller.query.trim()
                  ? "换个关键词再试试。"
                  : "开始录音或导入一段音频后，会显示在这里。"
              }
              compact
              className="row-start-2 min-h-0"
            />
          </div>
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
                  <button
                    type="button"
                    data-audio-id={audio.audioId}
                    data-flat-row="true"
                    aria-label={`打开 ${audio.displayName}`}
                    aria-current={selected ? "true" : undefined}
                    className="w-full px-3 py-3 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-current:bg-sidebar-accent"
                    onClick={() => void controller.selectAudio(audio.audioId)}
                  >
                    <span className="block truncate text-sm font-medium">
                      {audio.displayName}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {audio.segmentCount} 个片段
                    </span>
                    {state ? (
                      <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
                        <ProcessingIcon state={state} />
                        {taskStateLabel(state)}
                      </span>
                    ) : null}
                  </button>
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
  const [testing, setTesting] = React.useState(false);
  const [testPhase, setTestPhase] = React.useState<
    "closed" | "instructions" | "testing" | "result"
  >("closed");
  const [testSnapshot, setTestSnapshot] = React.useState<
    import("@shared/contracts").MicrophoneTestSnapshot | null
  >(null);
  const activeTestIdRef = React.useRef<string | null>(null);
  const lastMicrophoneAnnouncementRef = React.useRef(0);
  const [announcedMicrophoneActivity, setAnnouncedMicrophoneActivity] =
    React.useState("无");
  const [testResult, setTestResult] = React.useState<{
    title: string;
    description: string;
  } | null>(null);
  const microphoneDeviceId =
    selectPreferredMicrophone(
      preflight?.microphones ?? [],
      selectedMicrophoneDeviceId,
    )?.id ?? "";

  const stopTest = React.useCallback(async () => {
    const testId = testSnapshot?.testId;
    if (!testId) return;
    setTesting(true);
    try {
      const stopped = await controller.api.stopMicrophoneTest(testId);
      activeTestIdRef.current = null;
      setTestSnapshot(stopped);
      setTestResult({
        title: "麦克风测试完成",
        description: stopped.detectedInput
          ? "已检测到麦克风输入。"
          : "未检测到明显输入，请检查静音状态或输入设备。",
      });
      setTestPhase("result");
    } catch (reason) {
      activeTestIdRef.current = null;
      setTestResult({
        title: "麦克风测试失败",
        description: errorMessage(reason, "无法结束麦克风测试"),
      });
      setTestPhase("result");
    } finally {
      setTesting(false);
    }
  }, [controller.api, testSnapshot?.testId]);

  const loadMicrophones = React.useCallback(
    async (requestPermissions: boolean, selectedDeviceId: string) => {
      setTesting(true);
      setTestResult(null);
      try {
        const next = await refreshCapturePreflight(requestPermissions);
        const preferred = selectPreferredMicrophone(
          next.microphones,
          selectedDeviceId,
        );
        setSelectedMicrophoneDeviceId(preferred?.id ?? "");
        if (requestPermissions) {
          if (next.microphonePermission === "granted" && preferred) {
            const started = await controller.api.startMicrophoneTest({
              microphoneDeviceId: preferred.id,
            });
            activeTestIdRef.current = started.testId;
            lastMicrophoneAnnouncementRef.current = 0;
            setAnnouncedMicrophoneActivity("无");
            setTestSnapshot(started);
            setTestPhase("testing");
          } else {
            setTestResult({
              title: "麦克风测试失败",
              description: "麦克风暂不可用，请检查系统权限或设备连接。",
            });
            setTestPhase("result");
          }
        }
      } catch (reason) {
        setTestResult({
          title: "麦克风测试失败",
          description: errorMessage(reason, "无法测试麦克风"),
        });
        setTestPhase("result");
      } finally {
        setTesting(false);
      }
    },
    [controller.api, refreshCapturePreflight],
  );

  React.useEffect(() => {
    if (testPhase !== "testing" || !testSnapshot?.testId) return;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await controller.api.getMicrophoneTestSnapshot(
          testSnapshot.testId,
        );
        if (!active) return;
        setTestSnapshot(next);
        if (Date.now() - lastMicrophoneAnnouncementRef.current >= 1_000) {
          lastMicrophoneAnnouncementRef.current = Date.now();
          setAnnouncedMicrophoneActivity(
            microphoneActivityLabel(next.normalizedPeak),
          );
        }
        if (next.state !== "running") {
          activeTestIdRef.current = null;
          setTestResult({
            title: "麦克风测试完成",
            description: next.detectedInput
              ? "已检测到麦克风输入。"
              : "未检测到明显输入，请检查静音状态或输入设备。",
          });
          setTestPhase("result");
        }
      } catch (reason) {
        if (!active) return;
        setTestResult({
          title: "麦克风测试失败",
          description: errorMessage(reason, "无法读取麦克风状态"),
        });
        setTestPhase("result");
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [controller.api, testPhase, testSnapshot?.testId]);

  React.useEffect(() => {
    const api = controller.api;
    return () => {
      const testId = activeTestIdRef.current;
      activeTestIdRef.current = null;
      if (testId) void api.stopMicrophoneTest(testId);
    };
  }, [controller.api]);

  return (
    <section
      aria-label="录制准备"
      aria-busy={
        testing ||
        controller.capturePreflightPending ||
        controller.transitionPending
      }
      className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center"
    >
      <div className="space-y-2">
        <Label htmlFor="ready-microphone">麦克风</Label>
        <Select
          value={microphoneDeviceId}
          disabled={testing || !preflight?.microphones.length}
          onValueChange={setSelectedMicrophoneDeviceId}
        >
          <SelectTrigger id="ready-microphone" className="w-full">
            <SelectValue
              placeholder={testing ? "正在检测设备" : "没有可用设备"}
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
            testing ||
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
            !controller.captureReadyWithMicrophone || !microphoneDeviceId
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
          if (!open && testPhase !== "testing" && !testing) {
            setTestPhase("closed");
            setTestResult(null);
            setTestSnapshot(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {testPhase === "instructions"
                ? "测试麦克风"
                : testPhase === "testing"
                  ? "正在测试麦克风"
                  : testResult?.title}
            </DialogTitle>
            <DialogDescription>
              {testPhase === "instructions"
                ? "点击开始后，请对着当前选择的麦克风说话。测试由你结束，最长 30 秒。"
                : testPhase === "testing"
                  ? `剩余 ${Math.ceil((testSnapshot?.remainingMs ?? 30_000) / 1_000)} 秒 · 输入活动${microphoneActivityLabel(testSnapshot?.normalizedPeak ?? 0)}`
                  : testResult?.description}
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
                onClick={() => void loadMicrophones(true, microphoneDeviceId)}
              >
                开始测试
              </Button>
            </div>
          ) : testPhase === "testing" ? (
            <div className="space-y-4 pt-2">
              <div
                role="meter"
                aria-label="麦克风输入活动"
                aria-valuemin={0}
                aria-valuemax={3}
                aria-valuenow={microphoneActivityValue(
                  testSnapshot?.normalizedPeak ?? 0,
                )}
                aria-valuetext={microphoneActivityLabel(
                  testSnapshot?.normalizedPeak ?? 0,
                )}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${microphoneActivityValue(testSnapshot?.normalizedPeak ?? 0) * 33.333}%`,
                  }}
                />
              </div>
              <p role="status" aria-live="polite" className="text-sm">
                输入活动：{announcedMicrophoneActivity}
              </p>
              <div className="flex justify-end">
                <Button type="button" autoFocus onClick={() => void stopTest()}>
                  结束测试
                </Button>
              </div>
            </div>
          ) : testPhase === "result" ? (
            <div className="flex justify-end pt-2">
              <DialogClose asChild>
                <Button type="button">知道了</Button>
              </DialogClose>
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

function microphoneActivityValue(peak: number): number {
  if (peak >= 0.25) return 3;
  if (peak >= 0.06) return 2;
  if (peak >= 0.01) return 1;
  return 0;
}

function microphoneActivityLabel(peak: number): string {
  return ["无", "弱", "中", "强"][microphoneActivityValue(peak)]!;
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
