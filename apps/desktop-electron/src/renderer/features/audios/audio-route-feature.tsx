import * as React from "react";
import { toast } from "sonner";
import {
  AudioLines,
  FileInput,
  FileMusic,
  LoaderCircle,
  Mic,
  RotateCcw,
  Search,
  Square,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EmptyState, FullScreenEmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { ContextPaneSearch } from "@/features/shell/context-pane-controls";
import { ContextPaneSearchRegion } from "@/features/shell/context-pane-shell";
import {
  AudioDetailWorkspace,
  AudioPlaybackControls,
} from "@/features/audios/audio-workspace-feature";
import {
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "@/features/capture/use-recording-preference";
import type { CaptureLibraryOpenState } from "@/features/capture/capture-library-open-state";
import type { PendingJobAction } from "@/features/processing/use-processing-tasks";
import {
  desktopFailureHasCode,
  userFacingError,
} from "@/lib/user-facing-error";
import type {
  AudioMetadataPatch,
  AudioSummary,
  AudioPlaybackSnapshot,
  AudioWorkspaceSnapshot,
  CapturePreflight,
  ImportAudioResponse,
  ProcessingTask,
  Voice2TextDesktopApi,
  ApplicationSnapshot,
} from "@shared/contracts";

type AudioRouteOptions = {
  api: Voice2TextDesktopApi;
  tasks: readonly ProcessingTask[];
  pendingJobActions: ReadonlyMap<number, PendingJobAction>;
  writable: boolean;
  processingAvailable?: boolean;
  recordingActive?: boolean;
  captureStartPending?: boolean;
  newRecordingBlocked?: boolean;
  libraryRefreshToken?: string;
  recordingCompletionToken?: string | null;
  liveRegisteredAudio?: {
    intentId: string;
    audioId: number;
  } | null;
  active?: boolean;
  enabled?: boolean;
  onAudioSelected?: (audioId: number, source: "user" | "auto") => void;
  onRecord: () => void;
  onImport: () => Promise<ImportAudioResponse | undefined>;
  onProcessingUnavailable?: (reason?: string) => void;
  onCancel: (jobId: number) => void | Promise<void>;
  onRetry: (jobId: number, attempt: number) => void | Promise<void>;
};

type AudioFilter =
  "all" | "pending" | "transcribing" | "transcribed" | "exception";
const AUDIO_SEARCH_VISIBILITY_STORAGE_KEY =
  "voice2text.audio.context-search-visible.v1";
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
  captureStartPending = false,
  newRecordingBlocked = false,
  libraryRefreshToken,
  recordingCompletionToken = null,
  liveRegisteredAudio = null,
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
  const [searchVisible, setSearchVisible] = React.useState(
    readAudioSearchVisibility,
  );
  const [listError, setListError] = React.useState<string | null>(null);
  const [listPending, setListPending] = React.useState(true);
  const [workspace, setWorkspaceState] =
    React.useState<AudioWorkspaceSnapshot | null>(null);
  const [transitionError, setTransitionError] = React.useState<string | null>(
    null,
  );
  const [transitionPending, setTransitionPending] = React.useState(false);
  const [playback, setPlayback] = React.useState<AudioPlaybackSnapshot | null>(
    null,
  );
  const [playbackPending, setPlaybackPending] = React.useState(false);
  const [autoOpenState, setAutoOpenState] =
    React.useState<CaptureLibraryOpenState>({ phase: "idle" });
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
  const audiosRef = React.useRef(audios);
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
  const playbackPendingRef = React.useRef(false);
  const playbackActionTailRef = React.useRef<Promise<void>>(Promise.resolve());
  const preparedLeaveAudioIdRef = React.useRef<number | null>(null);
  const leaveRef = React.useRef<Promise<boolean> | null>(null);
  const workspaceMutationTailRef = React.useRef<Promise<void>>(
    Promise.resolve(),
  );
  const metadataDraftsRef = React.useRef(new Map<number, AudioMetadataPatch>());
  const metadataSavesRef = React.useRef(
    new Map<number, Promise<AudioWorkspaceSnapshot | null>>(),
  );
  const confirmedMetadataTitlesRef = React.useRef(new Map<number, string>());
  const activeRef = React.useRef(active);
  const observedLiveIntentRef = React.useRef<string | null>(null);
  const protectedWorkspaceAudioIdRef = React.useRef<number | null>(null);
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
      const promise = playbackActionTailRef.current
        .catch(() => undefined)
        .then(() => api.controlAudioPlayback(audioId, { action: "close" }))
        .then(() => undefined);
      playbackActionTailRef.current = promise.catch(() => undefined);
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
        protectedWorkspaceAudioIdRef.current === current.summary.audioId ||
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
      setPlayback(null);
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
        const presentAudioIds = new Set(next.map((audio) => audio.audioId));
        for (const audioId of confirmedMetadataTitlesRef.current.keys()) {
          if (!presentAudioIds.has(audioId)) {
            confirmedMetadataTitlesRef.current.delete(audioId);
          }
        }
        const projected = next.map((audio) => {
          const confirmedTitle = confirmedMetadataTitlesRef.current.get(
            audio.audioId,
          );
          if (confirmedTitle === undefined) return audio;
          if (audio.displayName === confirmedTitle) {
            confirmedMetadataTitlesRef.current.delete(audio.audioId);
            return audio;
          }
          return { ...audio, displayName: confirmedTitle };
        });
        audiosRef.current = projected;
        setAudios(projected);
        if (
          protectedWorkspaceAudioIdRef.current !== null &&
          next.some(
            (item) => item.audioId === protectedWorkspaceAudioIdRef.current,
          )
        ) {
          protectedWorkspaceAudioIdRef.current = null;
        }
        toast.dismiss("audio-library-refresh");
      } catch (cause) {
        if (intent === listIntentRef.current) {
          setListError(userFacingError(cause, "无法载入音频列表"));
          if (audiosRef.current) {
            toast.error("无法刷新音频列表，仍显示上次内容。", {
              id: "audio-library-refresh",
            });
          }
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

  const runWorkspaceMutation = React.useCallback(
    <T,>(action: () => Promise<T>): Promise<T> => {
      const request = workspaceMutationTailRef.current
        .catch(() => undefined)
        .then(action);
      workspaceMutationTailRef.current = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    },
    [],
  );

  const applyWorkspaceMutation = React.useCallback(
    async (
      action: (
        current: AudioWorkspaceSnapshot,
      ) => Promise<AudioWorkspaceSnapshot>,
    ): Promise<AudioWorkspaceSnapshot> =>
      await runWorkspaceMutation(async () => {
        const current = workspaceRef.current;
        if (!current) throw new Error("audio workspace is unavailable");
        const next = await action(current);
        if (workspaceRef.current?.summary.audioId === next.summary.audioId) {
          setWorkspace(next);
        }
        return next;
      }),
    [runWorkspaceMutation, setWorkspace],
  );

  const stageMetadata = React.useCallback(
    (audioId: number, patch: AudioMetadataPatch) => {
      metadataDraftsRef.current.set(audioId, {
        ...metadataDraftsRef.current.get(audioId),
        ...patch,
      });
    },
    [],
  );

  const saveMetadata = React.useCallback(
    (
      audioId: number,
      patch?: AudioMetadataPatch,
    ): Promise<AudioWorkspaceSnapshot | null> => {
      if (patch) stageMetadata(audioId, patch);
      const existing = metadataSavesRef.current.get(audioId);
      if (existing) return existing;
      const request = (async () => {
        let lastSnapshot: AudioWorkspaceSnapshot | null = null;
        let shouldRefresh = false;
        try {
          while (metadataDraftsRef.current.has(audioId)) {
            const nextPatch = metadataDraftsRef.current.get(audioId)!;
            metadataDraftsRef.current.delete(audioId);
            try {
              const next = await runWorkspaceMutation(async () => {
                let current = workspaceRef.current;
                if (!current || current.summary.audioId !== audioId) {
                  throw new Error(
                    "audio selection changed before metadata save",
                  );
                }
                try {
                  return await api.updateAudioMetadata({
                    audioId,
                    ...nextPatch,
                    expectedRevision: current.revision,
                  });
                } catch (cause) {
                  if (
                    !desktopFailureHasCode(
                      cause,
                      "audio-workspace",
                      "WORKSPACE_CONFLICT",
                    )
                  ) {
                    throw cause;
                  }
                  const refreshed = await api.openAudio(audioId);
                  if (!refreshed) throw cause;
                  current = refreshed;
                  if (workspaceRef.current?.summary.audioId === audioId) {
                    workspaceRef.current = refreshed;
                    setWorkspaceState(refreshed);
                  }
                  return await api.updateAudioMetadata({
                    audioId,
                    ...nextPatch,
                    expectedRevision: current.revision,
                  });
                }
              });
              lastSnapshot = next;
              if (workspaceRef.current?.summary.audioId === audioId) {
                workspaceRef.current = next;
                setWorkspaceState(next);
              }
              if (nextPatch.title !== undefined) {
                confirmedMetadataTitlesRef.current.set(
                  audioId,
                  next.summary.displayName,
                );
                const currentAudios = audiosRef.current;
                if (currentAudios) {
                  const updated = currentAudios.map((audio) =>
                    audio.audioId === audioId ? next.summary : audio,
                  );
                  audiosRef.current = updated;
                  setAudios(updated);
                }
              }
              shouldRefresh = true;
            } catch (cause) {
              metadataDraftsRef.current.set(audioId, {
                ...nextPatch,
                ...metadataDraftsRef.current.get(audioId),
              });
              throw cause;
            }
          }
          return lastSnapshot;
        } finally {
          if (shouldRefresh) void refreshAudios();
        }
      })();
      metadataSavesRef.current.set(audioId, request);
      const clearRequest = () => {
        if (metadataSavesRef.current.get(audioId) === request) {
          metadataSavesRef.current.delete(audioId);
        }
      };
      void request.then(clearRequest, clearRequest);
      return request;
    },
    [api, refreshAudios, runWorkspaceMutation, stageMetadata],
  );

  const flushMetadata = React.useCallback(
    async (audioId: number, discardOnFailure = false): Promise<boolean> => {
      try {
        await saveMetadata(audioId);
        return true;
      } catch {
        if (discardOnFailure) metadataDraftsRef.current.delete(audioId);
        return false;
      }
    },
    [saveMetadata],
  );

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
      if (current) {
        void (async () => {
          await flushMetadata(current.summary.audioId, true);
          await requestPlaybackClose(current.summary.audioId);
        })().catch(() => undefined);
      }
    },
    [flushMetadata, requestPlaybackClose],
  );

  React.useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    const current = workspaceRef.current;
    if (wasActive && !active) {
      selectionIntentRef.current += 1;
      if (current) {
        if (preparedLeaveAudioIdRef.current === current.summary.audioId) {
          preparedLeaveAudioIdRef.current = null;
          return;
        }
        void (async () => {
          await flushMetadata(current.summary.audioId, true);
          await requestPlaybackClose(current.summary.audioId);
        })().catch((cause) => {
          setTransitionError(
            userFacingError(cause, "离开音频工作区时无法关闭播放"),
          );
        });
      }
    } else if (!wasActive && active) {
      closeRef.current = null;
    }
  }, [active, flushMetadata, requestPlaybackClose]);

  const selectAudio = React.useCallback(
    async (
      audioId: number,
      options?: { fromRoute?: boolean; source?: "user" | "auto" },
    ): Promise<"opened" | "failed" | "canceled"> => {
      const current = workspaceRef.current;
      preparedLeaveAudioIdRef.current = null;
      if (current?.summary.audioId === audioId) {
        setTransitionError(null);
        if (!options?.fromRoute)
          onAudioSelected?.(audioId, options?.source ?? "user");
        return "opened";
      }
      const intent = ++selectionIntentRef.current;
      transitionCountRef.current += 1;
      setTransitionPending(true);
      setTransitionError(null);
      try {
        if (current) {
          await flushMetadata(current.summary.audioId, true);
          try {
            await requestPlaybackClose(current.summary.audioId);
          } catch (cause) {
            if (intent === selectionIntentRef.current) {
              setTransitionError(
                userFacingError(cause, "无法切换音频，请重试"),
              );
            }
            return "failed";
          }
        }
        setPlayback(null);
        if (intent !== selectionIntentRef.current) return "canceled";
        const next = await api.openAudio(audioId);
        if (intent !== selectionIntentRef.current) return "canceled";
        if (!next) throw new Error("音频不存在或已被移除");
        workspaceRef.current = next;
        setWorkspaceState(next);
        closeRef.current = null;
        if (!options?.fromRoute)
          onAudioSelected?.(audioId, options?.source ?? "user");
        return "opened";
      } catch (cause) {
        if (intent === selectionIntentRef.current) {
          setTransitionError(userFacingError(cause, "无法打开音频"));
        }
        return "failed";
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
    [api, flushMetadata, onAudioSelected, requestPlaybackClose],
  );

  const openRegisteredAudio = React.useCallback(
    async (intentId: string, audioId: number) => {
      protectedWorkspaceAudioIdRef.current = audioId;
      setAutoOpenState({ phase: "opening", intentId, audioId });
      const result = await selectAudio(audioId, { source: "auto" });
      if (result === "opened") {
        setAutoOpenState((current) =>
          current.phase !== "idle" && current.intentId === intentId
            ? { phase: "idle" }
            : current,
        );
        return;
      }
      if (result === "canceled") {
        if (observedLiveIntentRef.current === intentId) {
          protectedWorkspaceAudioIdRef.current = null;
          setAutoOpenState((current) =>
            current.phase !== "idle" && current.intentId === intentId
              ? { phase: "idle" }
              : current,
          );
        }
        return;
      }
      setAutoOpenState((current) =>
        current.phase !== "idle" && current.intentId === intentId
          ? {
              phase: "open_failed",
              intentId,
              audioId,
              message: "录音已加入音频资料库，但暂时无法打开。",
            }
          : current,
      );
    },
    [selectAudio],
  );

  React.useEffect(() => {
    setAutoOpenState((current) => {
      if (
        current.phase === "idle" ||
        (liveRegisteredAudio?.intentId === current.intentId &&
          liveRegisteredAudio.audioId === current.audioId)
      ) {
        return current;
      }
      protectedWorkspaceAudioIdRef.current = null;
      return { phase: "idle" };
    });
  }, [liveRegisteredAudio?.audioId, liveRegisteredAudio?.intentId]);

  React.useEffect(() => {
    if (!liveRegisteredAudio) return;
    if (observedLiveIntentRef.current === liveRegisteredAudio.intentId) return;
    if (!enabled || !active) return;
    observedLiveIntentRef.current = liveRegisteredAudio.intentId;
    const { intentId, audioId } = liveRegisteredAudio;
    void Promise.resolve().then(() => {
      if (observedLiveIntentRef.current !== intentId || !activeRef.current) {
        return;
      }
      void openRegisteredAudio(intentId, audioId);
      void loadAudios();
    });
  }, [active, enabled, liveRegisteredAudio, openRegisteredAudio, loadAudios]);

  const retryAutoOpen = React.useCallback(() => {
    if (autoOpenState.phase !== "open_failed") return;
    void openRegisteredAudio(autoOpenState.intentId, autoOpenState.audioId);
  }, [autoOpenState, openRegisteredAudio]);

  const clearSelection = React.useCallback(async () => {
    const current = workspaceRef.current;
    if (!current) return;
    const intent = ++selectionIntentRef.current;
    await flushMetadata(current.summary.audioId, true);
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
    setPlayback(null);
    closeRef.current = null;
  }, [flushMetadata, requestPlaybackClose]);

  const prepareToLeave = React.useCallback((): Promise<boolean> => {
    if (leaveRef.current) return leaveRef.current;
    const request = (async () => {
      const current = workspaceRef.current;
      if (!current) return true;
      await flushMetadata(current.summary.audioId, true);
      try {
        await requestPlaybackClose(current.summary.audioId);
        if (workspaceRef.current?.summary.audioId === current.summary.audioId) {
          preparedLeaveAudioIdRef.current = current.summary.audioId;
          setPlayback(null);
        }
        return true;
      } catch (cause) {
        setTransitionError(
          userFacingError(cause, "离开音频工作区时无法关闭播放"),
        );
        return false;
      }
    })();
    leaveRef.current = request;
    const clear = () => {
      if (leaveRef.current === request) leaveRef.current = null;
    };
    void request.then(clear, clear);
    return request;
  }, [flushMetadata, requestPlaybackClose]);

  const controlPlayback = React.useCallback(
    async (
      command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
    ) => {
      const current = workspaceRef.current;
      if (!current || playbackPendingRef.current || closeRef.current) return;
      const audioId = current.summary.audioId;
      playbackPendingRef.current = true;
      setPlaybackPending(true);
      try {
        let next: AudioPlaybackSnapshot | null = null;
        const request = playbackActionTailRef.current
          .catch(() => undefined)
          .then(async () => {
            let snapshot = playback;
            if (!snapshot?.initialized && command.action !== "open") {
              snapshot = await api.controlAudioPlayback(audioId, {
                action: "open",
              });
            }
            next =
              command.action === "open"
                ? snapshot!
                : await api.controlAudioPlayback(audioId, command);
          });
        playbackActionTailRef.current = request.catch(() => undefined);
        await request;
        if (workspaceRef.current?.summary.audioId === audioId && next) {
          setPlayback(next);
        }
        toast.dismiss("audio-playback-action");
      } catch (cause) {
        toast.error(userFacingError(cause, "音频操作未完成，请重试。"), {
          id: "audio-playback-action",
        });
      } finally {
        playbackPendingRef.current = false;
        setPlaybackPending(false);
      }
    },
    [api, playback],
  );

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

  const deleteAudio = React.useCallback(
    async (audioId: number): Promise<boolean> => {
      const selected = workspaceRef.current?.summary.audioId === audioId;
      let discardedDraft: AudioMetadataPatch | undefined;
      if (selected) {
        selectionIntentRef.current += 1;
        discardedDraft = metadataDraftsRef.current.get(audioId);
        metadataDraftsRef.current.delete(audioId);
        const activeMetadataSave = metadataSavesRef.current.get(audioId);
        try {
          await Promise.all([
            activeMetadataSave?.catch(() => undefined) ?? Promise.resolve(),
            requestPlaybackClose(audioId),
          ]);
        } catch (cause) {
          if (discardedDraft) {
            metadataDraftsRef.current.set(audioId, discardedDraft);
          }
          toast.error(userFacingError(cause, "无法关闭音频播放，请重试。"));
          return false;
        }
        const requeuedDraft = metadataDraftsRef.current.get(audioId);
        if (requeuedDraft) {
          discardedDraft = { ...discardedDraft, ...requeuedDraft };
          metadataDraftsRef.current.delete(audioId);
        }
      }
      try {
        await api.deleteAudio(audioId);
        listIntentRef.current += 1;
        metadataDraftsRef.current.delete(audioId);
        metadataSavesRef.current.delete(audioId);
        confirmedMetadataTitlesRef.current.delete(audioId);
        const nextAudios = (audiosRef.current ?? []).filter(
          (audio) => audio.audioId !== audioId,
        );
        audiosRef.current = nextAudios;
        setAudios(nextAudios);
        if (workspaceRef.current?.summary.audioId === audioId) {
          workspaceRef.current = null;
          setWorkspaceState(null);
          setPlayback(null);
          closeRef.current = null;
        }
        toast.success("录音已删除。", { id: "audio-delete" });
        return true;
      } catch (cause) {
        if (discardedDraft) {
          metadataDraftsRef.current.set(audioId, discardedDraft);
        }
        toast.error(userFacingError(cause, "无法删除录音，请重试。"), {
          id: "audio-delete",
        });
        return false;
      }
    },
    [api, requestPlaybackClose],
  );

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
      if (desktopFailureHasCode(cause, "local-model", "MODEL_BUSY")) {
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

  const toggleSearchVisibility = React.useCallback(() => {
    const next = !searchVisible;
    setSearchVisible(next);
    writeAudioSearchVisibility(next);
  }, [searchVisible]);

  const filterCounts = React.useMemo(() => {
    const counts: Record<AudioFilter, number> = {
      all: audios?.length ?? 0,
      pending: 0,
      transcribing: 0,
      transcribed: 0,
      exception: 0,
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
    searchVisible,
    toggleSearchVisibility,
    filter,
    setFilter,
    filterCounts,
    listError,
    listPending,
    reload: loadAudios,
    workspace,
    setWorkspace,
    applyWorkspaceMutation,
    saveMetadata,
    flushMetadata,
    prepareToLeave,
    selectAudio,
    clearSelection,
    transitionError,
    dismissTransitionError: () => setTransitionError(null),
    transitionPending,
    playback,
    playbackPending,
    controlPlayback,
    autoOpenState,
    retryAutoOpen,
    importPending,
    importError,
    importAudio,
    deleteAudio,
    record: onRecord,
    recordingActive,
    newRecordingBlocked,
    capturePreflight,
    capturePreflightPending,
    captureStartPending,
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
              <AudioContextPaneHeader controller={controller} />
            </div>
          ) : null}
          {controller.libraryPresentation === "populated" ? (
            <ContextPaneSearchRegion open={controller.searchVisible}>
              <AudioContextPaneToolbar controller={controller} />
            </ContextPaneSearchRegion>
          ) : null}
          <div className="min-h-0 flex-1">
            <AudioContextPane controller={controller} />
          </div>
          {controller.libraryPresentation === "populated" ? (
            <div
              data-audio-context-footer="true"
              className="shrink-0 border-t p-2"
            >
              <AudioContextPaneFooter controller={controller} />
            </div>
          ) : null}
        </section>
      ) : null}
      <section role="region" aria-label="音频工作区">
        <AudioMainWorkspace controller={controller} />
        {controller.workspace ? (
          <AudioMainPlaybackFooter controller={controller} />
        ) : null}
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
    <div className="flex items-center">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-7"
        aria-label={controller.searchVisible ? "隐藏音频搜索" : "显示音频搜索"}
        aria-pressed={controller.searchVisible}
        onClick={controller.toggleSearchVisibility}
      >
        <Search aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AudioContextPaneFooter({
  controller,
}: {
  controller: AudioRouteController;
}) {
  if (controller.libraryPresentation !== "populated") return null;
  const recordingLabel = controller.recordingActive
    ? "正在录音"
    : controller.captureStartPending
      ? "正在开始录制"
      : "新录音";
  return (
    <div className="flex items-center gap-2" role="group" aria-label="音频操作">
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="导入音频"
        aria-busy={controller.importPending}
        disabled={!controller.writable || controller.importPending}
        onClick={() => void controller.importAudio()}
      >
        <FileMusic aria-hidden="true" />
      </Button>
      <Button
        data-recording-entry="audio-context-pane"
        type="button"
        className="min-w-0 flex-1"
        aria-label={recordingLabel}
        disabled={
          !controller.captureReadyWithMicrophone ||
          controller.recordingActive ||
          controller.newRecordingBlocked ||
          controller.capturePreflightPending ||
          controller.captureStartPending
        }
        onClick={() => controller.record()}
      >
        {controller.captureStartPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
        {controller.recordingActive
          ? "正在录音"
          : controller.captureStartPending
            ? "正在开始录制"
            : "开始新录音"}
      </Button>
    </div>
  );
}

export function AudioContextPane({
  controller,
}: {
  controller: AudioRouteController;
}) {
  const [deleteTarget, setDeleteTarget] = React.useState<AudioSummary | null>(
    null,
  );
  const [deletePending, setDeletePending] = React.useState(false);
  if (controller.libraryPresentation !== "populated") {
    if (!controller.workspace) return null;
    return (
      <SidebarGroup className="h-full p-0">
        <SidebarGroupContent className="flex h-full flex-col">
          {controller.libraryPresentation === "error" ? (
            <div role="alert" className="space-y-2 border-b p-3 text-sm">
              <p>{controller.listError}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void controller.reload()}
              >
                <RotateCcw aria-hidden="true" />
                重新载入音频列表
              </Button>
            </div>
          ) : (
            <p
              role="status"
              className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
            >
              <LoaderCircle
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
              正在同步音频列表…
            </p>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }
  return (
    <SidebarGroup className="h-full p-0">
      <SidebarGroupContent className="flex h-full flex-col">
        <h3 className="sr-only">音频列表</h3>
        {controller.importError ? (
          <div className="border-b px-3 py-2">
            <AudioImportError controller={controller} />
          </div>
        ) : null}
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
            description="没有匹配的音频"
            compact
            className="min-h-0 flex-1"
          />
        ) : (
          <ul aria-label="音频列表" data-flat-row-list="true">
            {controller.filteredAudios.map((audio) => {
              const selected =
                controller.workspace?.summary.audioId === audio.audioId;
              return (
                <li key={audio.audioId}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <Item
                        asChild
                        variant="context"
                        size="context"
                        className="text-left"
                      >
                        <button
                          type="button"
                          data-audio-id={audio.audioId}
                          data-flat-row="true"
                          aria-label={`打开 ${audio.displayName}`}
                          aria-current={selected ? "true" : undefined}
                          onClick={() =>
                            void controller.selectAudio(audio.audioId)
                          }
                        >
                          <ItemContent>
                            <ItemTitle>{audio.displayName}</ItemTitle>
                            <ItemDescription>
                              <span className="block">
                                {formatAudioDate(audio.createdAtMs)} ·{" "}
                                {formatAudioDuration(audio.durationMs)}
                              </span>
                            </ItemDescription>
                          </ItemContent>
                        </button>
                      </Item>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        variant="destructive"
                        disabled={
                          !controller.writable || controller.transitionPending
                        }
                        onSelect={() => setDeleteTarget(audio)}
                      >
                        <Trash2 aria-hidden="true" />
                        删除
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        )}
        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open && !deletePending) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除确认</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget
                  ? `“${deleteTarget.displayName}”及其转写内容和 AI 总结将从资料库中移除，且无法恢复。`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={deletePending}
                >
                  取消
                </Button>
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={deletePending}
                onClick={() => {
                  if (!deleteTarget || deletePending) return;
                  setDeletePending(true);
                  void controller
                    .deleteAudio(deleteTarget.audioId)
                    .then((deleted) => {
                      if (deleted) setDeleteTarget(null);
                    })
                    .finally(() => setDeletePending(false));
                }}
              >
                {deletePending ? "正在删除…" : "确认删除"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AudioContextPaneToolbar({
  controller,
}: {
  controller: AudioRouteController;
}) {
  const filters: readonly { value: AudioFilter; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "pending", label: "待转写" },
    { value: "transcribing", label: "转写中" },
    { value: "transcribed", label: "已转写" },
    { value: "exception", label: "异常" },
  ];
  const selectedFilter = filters.find(
    (item) => item.value === controller.filter,
  )!;
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (controller.searchVisible) searchInputRef.current?.focus();
  }, [controller.searchVisible]);
  return (
    <ButtonGroup className="w-full">
      <ContextPaneSearch
        ref={searchInputRef}
        aria-label="搜索音频"
        className="rounded-r-none"
        value={controller.query}
        onChange={(event) => controller.setQuery(event.currentTarget.value)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`筛选音频：${selectedFilter.label}`}
          >
            {selectedFilter.label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuLabel>筛选音频</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={controller.filter}
            onValueChange={(value) =>
              controller.setFilter(value as AudioFilter)
            }
          >
            {filters.map((item) => (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                <span className="flex flex-1 items-center justify-between gap-4">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {controller.filterCounts[item.value]}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

function readAudioSearchVisibility(): boolean {
  try {
    return (
      window.localStorage.getItem(AUDIO_SEARCH_VISIBILITY_STORAGE_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

function writeAudioSearchVisibility(visible: boolean) {
  try {
    window.localStorage.setItem(
      AUDIO_SEARCH_VISIBILITY_STORAGE_KEY,
      String(visible),
    );
  } catch {
    // A denied storage write must not prevent the user from toggling search.
  }
}

export function AudioMainWorkspace({
  controller,
  operationError,
  showRecordingReady = true,
  recordingSessionId = null,
  libraryProjection,
}: {
  controller: AudioRouteController;
  operationError?: string | null;
  showRecordingReady?: boolean;
  recordingSessionId?: string | null;
  libraryProjection?: ApplicationSnapshot["libraryProjection"];
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
        <AudioTransitionErrorDialog
          message={controller.transitionError}
          onDismiss={controller.dismissTransitionError}
        />
      ) : null}
      {workspace ? (
        <div key={workspace.summary.audioId} className="space-y-4">
          <AudioDetailWorkspace
            api={controller.api}
            workspace={workspace}
            routePending={controller.transitionPending}
            onWorkspaceChange={controller.setWorkspace}
            onWorkspaceMutation={controller.applyWorkspaceMutation}
            onSaveMetadata={(patch) =>
              controller.saveMetadata(workspace.summary.audioId, patch)
            }
            playback={controller.playback}
            playbackPending={
              controller.playbackPending || controller.transitionPending
            }
            onPlaybackAction={controller.controlPlayback}
            transcriptStatus={
              !task && workspace.segments.length === 0 ? (
                <Button
                  data-recording-entry="audio-first-use"
                  type="button"
                  disabled={controller.transitionPending}
                  onClick={() => void controller.startTranscription()}
                >
                  开始转写
                </Button>
              ) : task &&
                !(
                  task.state === "completed" && workspace.segments.length > 0
                ) ? (
                <AudioProcessingDetail
                  task={task}
                  pendingAction={controller.pendingJobActions.get(task.id)}
                  onCancel={controller.onCancel}
                  onRetry={controller.onRetry}
                />
              ) : null
            }
          />
        </div>
      ) : controller.autoOpenState.phase === "opening" ? (
        <div
          role="status"
          className="flex min-h-72 flex-1 flex-col items-center justify-center gap-1 text-center"
        >
          <p className="text-sm font-medium">正在打开新音频</p>
          <p className="text-sm text-muted-foreground">
            音频已加入资料库，正在打开详情。
          </p>
        </div>
      ) : controller.autoOpenState.phase === "open_failed" ? (
        <div
          role="alert"
          className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 text-center"
        >
          <p className="text-sm font-medium">新音频暂时无法打开</p>
          <p className="text-sm text-muted-foreground">
            {controller.autoOpenState.message}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={controller.retryAutoOpen}
          >
            重试打开音频
          </Button>
        </div>
      ) : controller.libraryPresentation === "loading" ? (
        <AudioLibraryLoading />
      ) : controller.libraryPresentation === "error" ? (
        <AudioLibraryError controller={controller} />
      ) : controller.libraryPresentation === "true-empty" &&
        showRecordingReady ? (
        <RecordingReadyState controller={controller} />
      ) : controller.libraryPresentation === "true-empty" ? (
        <RecordingLibrarySyncState
          api={controller.api}
          sessionId={recordingSessionId}
          projection={libraryProjection}
        />
      ) : controller.libraryPresentation === "populated" && !workspace ? (
        <AudioSelectionPrompt />
      ) : null}
    </div>
  );
}

function RecordingLibrarySyncState({
  api,
  sessionId,
  projection,
}: {
  api: Voice2TextDesktopApi;
  sessionId: string | null;
  projection: ApplicationSnapshot["libraryProjection"] | undefined;
}) {
  const [retryPending, setRetryPending] = React.useState(false);
  if (
    projection?.phase === "registering" ||
    projection?.phase === "registered"
  ) {
    const opening = projection.phase === "registered";
    return (
      <div
        role="status"
        aria-label={opening ? "正在打开新音频" : "正在同步音频资料库"}
        className="flex min-h-72 flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <LoaderCircle
          className="size-5 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">录音已保存</p>
        <p className="text-sm text-muted-foreground">
          {opening
            ? "音频已加入资料库，正在打开详情。"
            : "正在同步音频资料库。"}
        </p>
      </div>
    );
  }

  const retryRequest =
    sessionId && projection?.phase === "failed"
      ? {
          sessionId: projection.sessionId,
          intentId: projection.intentId,
        }
      : sessionId && projection?.phase === "idle"
        ? { sessionId, intentId: "idle-recovery" }
        : null;
  const message =
    projection?.phase === "failed"
      ? projection.message
      : "音频资料库尚未更新。";
  return (
    <div
      role="alert"
      className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 text-center"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">录音已保存</p>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      {retryRequest ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={retryPending}
          onClick={() => {
            setRetryPending(true);
            void api
              .retryCaptureLibraryProjection(retryRequest)
              .catch((cause) => {
                toast.error(userFacingError(cause, "无法重新同步音频资料库"));
              })
              .finally(() => setRetryPending(false));
          }}
        >
          {retryPending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          重试同步
        </Button>
      ) : null}
    </div>
  );
}

export function AudioMainPlaybackFooter({
  controller,
}: {
  controller: AudioRouteController;
}) {
  if (!controller.workspace) return null;
  return (
    <AudioPlaybackControls
      playback={controller.playback}
      durationMs={controller.workspace.summary.durationMs}
      pending={controller.playbackPending || controller.transitionPending}
      onAction={(command) => void controller.controlPlayback(command)}
    />
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
  return <EmptyState description="请选择左侧音频" className="flex-1" />;
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
    <div data-audio-first-use="frame" className="contents">
      <FullScreenEmptyState
        icon={<AudioLines aria-hidden="true" />}
        title="开始你的第一段音频"
        description={
          <>
            <span className="block">录制一段新音频，或导入已有文件</span>
            <span className="block">开始转写和整理。</span>
          </>
        }
        busy={
          controller.capturePreflightPending ||
          controller.captureStartPending ||
          controller.transitionPending
        }
        actions={
          <>
            <Button
              type="button"
              disabled={
                controller.capturePreflightPending ||
                controller.captureStartPending ||
                !controller.captureReadyWithMicrophone ||
                !microphone ||
                controller.recordingActive ||
                controller.newRecordingBlocked
              }
              onClick={() => controller.record()}
            >
              {controller.capturePreflightPending ||
              controller.captureStartPending ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Mic aria-hidden="true" />
              )}
              {controller.captureStartPending
                ? "正在开始录制…"
                : controller.capturePreflightPending
                  ? "正在检查麦克风…"
                  : "开始录制"}
            </Button>
            <AudioImportButton
              controller={controller}
              label="导入外部音频"
              showIcon={false}
            />
          </>
        }
        feedback={
          controller.importError || controller.capturePreflightError ? (
            <>
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
            </>
          ) : undefined
        }
      />
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

function audioFilterFor(
  audio: AudioSummary,
  task: ProcessingTask | null,
): Exclude<AudioFilter, "all"> {
  const state = task?.state ?? audio.processingState;
  if (state === "not-started") return "pending";
  if (state === "completed") return "transcribed";
  if (state === "queued" || state === "running" || state === "canceling") {
    return "transcribing";
  }
  return "exception";
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

function AudioTransitionErrorDialog({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>音频操作未完成</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
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
