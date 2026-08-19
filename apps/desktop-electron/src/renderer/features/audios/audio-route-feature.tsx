import * as React from "react";
import {
  Ban,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Mic2,
  RotateCcw,
  Search,
  Square,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarInput,
} from "@/components/ui/sidebar";
import { AudioDetailWorkspace } from "@/features/audios/audio-workspace-feature";
import type { PendingJobAction } from "@/features/processing/use-processing-tasks";
import type {
  AudioSummary,
  AudioWorkspaceSnapshot,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "@shared/contracts";

type AudioRouteOptions = {
  api: Voice2TextDesktopApi;
  tasks: readonly ProcessingTask[];
  pendingJobActions: ReadonlyMap<number, PendingJobAction>;
  writable: boolean;
  active?: boolean;
  enabled?: boolean;
  onRecord: () => void;
  onImport: () => void | Promise<void>;
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
  active = true,
  enabled = true,
  onRecord,
  onImport,
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
  const workspaceRef = React.useRef(workspace);
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
    [api, requestPlaybackClose],
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
    writable,
    tasks,
    tasksByAudioId,
    pendingJobActions,
    onCancel,
    onRetry,
  };
}

export function AudioRouteFeature({
  paneOpen,
  onOpenPane,
  ...options
}: AudioRouteOptions & { paneOpen: boolean; onOpenPane: () => void }) {
  const controller = useAudioRouteController(options);
  return (
    <div className="contents">
      {paneOpen ? (
        <section role="region" aria-label="音频列表">
          <AudioContextPaneHeader controller={controller} />
          <AudioContextPane controller={controller} />
        </section>
      ) : null}
      <section role="region" aria-label="音频工作区">
        <AudioMainWorkspace controller={controller} onOpenPane={onOpenPane} />
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
    <>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
        />
        <SidebarInput
          type="search"
          aria-label="搜索音频"
          value={controller.query}
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          className="pl-8"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!controller.writable}
          onClick={controller.record}
        >
          <Mic2 aria-hidden="true" />
          开始录音
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!controller.writable || controller.importPending}
          aria-busy={controller.importPending}
          onClick={() => void controller.importAudio()}
        >
          <Upload aria-hidden="true" />
          {controller.importPending ? "正在导入音频" : "导入音频"}
        </Button>
      </div>
    </>
  );
}

export function AudioContextPane({
  controller,
}: {
  controller: AudioRouteController;
}) {
  return (
    <SidebarGroup className="p-0">
      <SidebarGroupContent>
        <h3 className="sr-only">音频列表</h3>
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
          <div
            role="status"
            aria-label="正在载入音频列表"
            className="flex items-center gap-2 px-3 py-4 text-sm"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            正在载入音频列表
          </div>
        ) : controller.filteredAudios.length === 0 ? (
          <div className="px-3 py-4 text-sm">
            <p className="font-medium">
              {controller.query.trim() ? "没有匹配的音频" : "还没有音频"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {controller.query.trim()
                ? "请调整搜索内容。"
                : "可从上方开始录音或导入音频。"}
            </p>
          </div>
        ) : (
          <ul
            aria-label="音频列表"
            data-flat-row-list="true"
            className="divide-y divide-sidebar-border border-y border-sidebar-border"
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
  onOpenPane,
  operationError,
}: {
  controller: AudioRouteController;
  onOpenPane: () => void;
  operationError?: string | null;
}) {
  const workspace = controller.workspace;
  const task = workspace
    ? selectCurrentTask(
        controller.tasksByAudioId.get(workspace.summary.audioId),
      )
    : null;
  return (
    <div className="space-y-4">
      <ProcessingLiveStatus tasks={controller.tasks} />
      {operationError ? <AudioOperationError message={operationError} /> : null}
      {controller.transitionError ? (
        <AudioOperationError message={controller.transitionError} />
      ) : null}
      {!workspace ? (
        <section
          className="grid min-h-96 place-items-center text-center"
          aria-busy={controller.transitionPending}
        >
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">音频</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              从音频列表选择要复核的内容。
            </p>
            <Button type="button" className="mt-5" onClick={onOpenPane}>
              打开音频列表
            </Button>
          </div>
        </section>
      ) : (
        <div key={workspace.summary.audioId} className="space-y-4">
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
      )}
    </div>
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
  if (state === "completed" || state === "partial-success") return null;
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
