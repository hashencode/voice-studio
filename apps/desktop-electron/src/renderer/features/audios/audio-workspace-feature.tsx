import * as React from "react";
import { toast } from "sonner";
import {
  Astroid,
  HardDrive,
  MessageSquareText,
  MessagesSquare,
  Pause,
  Play,
  Redo2,
  Rows3,
  RotateCcw,
  RotateCw,
  Search,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";
import { audioWorkspaceLimits } from "../../../shared/contracts";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { ButtonGroup } from "@/components/ui/button-group";
import { EmptyState, FullScreenEmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { AudioAiFeature } from "@/features/audio-ai/audio-ai-feature";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  AudioExportFormat,
  AudioMetadataPatch,
  AudioPlaybackSnapshot,
  AudioSegment,
  AudioSpeakerState,
  AudioSummary,
  AudioWorkspaceSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";

const rowHeight = 190;
const visibleRows = 12;
const overscan = 4;
const audioWorkspaceTabs = [
  { value: "transcript", label: "转写文本", icon: MessageSquareText },
  { value: "summary", label: "AI 总结", icon: Astroid },
  { value: "knowledge", label: "知识库", icon: HardDrive },
] as const;
type AudioWorkspaceTab = (typeof audioWorkspaceTabs)[number]["value"];
type TranscriptViewMode = "flat" | "conversation";

type SearchResultIdentity = Pick<
  AudioSegment,
  "id" | "stableKey" | "sequenceId"
>;
type WorkspaceMutationAction = (
  current: AudioWorkspaceSnapshot,
) => Promise<AudioWorkspaceSnapshot>;

function InlineTextEditor({
  ariaLabel,
  className,
  initialValue,
  onCancel,
  onCommit,
  onKeyboardExit,
}: {
  ariaLabel: string;
  className: string;
  initialValue: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
  onKeyboardExit: () => void;
}) {
  const normalizeSingleLine = (value: string) =>
    value.replaceAll(/\r?\n/g, " ");
  const editorRef = React.useRef<HTMLSpanElement>(null);
  const canceledRef = React.useRef(false);
  const initialValueRef = React.useRef(initialValue);

  React.useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.textContent = normalizeSingleLine(initialValueRef.current);
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const readValue = (editor: HTMLSpanElement) => {
    const value = editor.innerText || editor.textContent || "";
    return normalizeSingleLine(value);
  };

  const insertText = (text: string) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  return (
    <span
      ref={editorRef}
      role="textbox"
      aria-label={ariaLabel}
      contentEditable
      data-plaintext-only="true"
      suppressContentEditableWarning
      spellCheck
      className={className}
      onPaste={(event) => {
        event.preventDefault();
        const pasted = event.clipboardData.getData("text/plain");
        const text = normalizeSingleLine(pasted);
        insertText(text);
      }}
      onBlur={(event) => {
        if (canceledRef.current) return;
        onCommit(readValue(event.currentTarget));
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          canceledRef.current = true;
          onKeyboardExit();
          onCancel();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onKeyboardExit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function AudioWorkspaceFeature({
  api = window.voice2text,
}: {
  api?: Voice2TextDesktopApi;
}) {
  const [audios, setAudios] = React.useState<AudioSummary[] | null>(null);
  const [workspace, setWorkspace] =
    React.useState<AudioWorkspaceSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [libraryQuery, setLibraryQuery] = React.useState("");
  const pendingRef = React.useRef(false);

  const loadAudios = React.useCallback(
    async (query = "") => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        const next = await api.listAudios(query);
        setAudios(next);
      } catch (cause) {
        setError(userFacingError(cause, "无法载入音频资料库"));
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [api],
  );

  React.useEffect(() => {
    let active = true;
    void api
      .listAudios()
      .then((next) => {
        if (!active) return;
        setAudios(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(userFacingError(cause, "无法载入音频资料库"));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const openAudio = async (audioId: number) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await api.openAudio(audioId);
      if (!next) throw new Error("音频不存在或已被移除");
      setWorkspace(next);
    } catch (cause) {
      setError(userFacingError(cause, "无法打开音频"));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (audios === null && !error) return <AudioLoading />;
  if (!workspace) {
    return (
      <section
        aria-labelledby="audio-library-title"
        aria-busy={pending}
        className="space-y-5"
      >
        <div>
          <p className="text-sm font-medium text-muted-foreground">本机音频</p>
          <h1
            id="audio-library-title"
            className="text-2xl font-semibold tracking-tight"
          >
            音频资料库
          </h1>
        </div>
        <form
          className="flex max-w-xl gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void loadAudios(libraryQuery);
          }}
          role="search"
        >
          <Input
            aria-label="搜索音频资料库"
            value={libraryQuery}
            onChange={(event) => setLibraryQuery(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            <Search aria-hidden="true" />
            搜索
          </Button>
        </form>
        {error ? (
          <RecoveryError
            message={error}
            pending={pending}
            onRetry={() => void loadAudios(libraryQuery)}
          />
        ) : audios?.length === 0 ? (
          <EmptyState title="还没有可复核的音频" className="border-b" />
        ) : (
          <ul
            aria-label="音频列表"
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          >
            {audios?.map((audio) => (
              <li key={audio.audioId}>
                <button
                  type="button"
                  aria-label={`打开 ${audio.displayName}`}
                  className="w-full rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                  data-audio-id={audio.audioId}
                  disabled={pending}
                  onClick={() => void openAudio(audio.audioId)}
                >
                  <span className="block truncate font-medium">
                    {audio.displayName}
                  </span>
                  <span className="mt-2 block text-sm text-muted-foreground">
                    {audio.segmentCount} 个片段 ·{" "}
                    {processingLabel(audio.processingState)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <WorkspaceView
      api={api}
      workspace={workspace}
      pending={pending}
      error={error}
      setPending={setPending}
      setError={setError}
      setWorkspace={setWorkspace}
      onBack={() => {
        const audioId = workspace.summary.audioId;
        setWorkspace(null);
        setError(null);
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>(`[data-audio-id="${audioId}"]`)
            ?.focus();
        });
      }}
    />
  );
}

export function AudioDetailWorkspace({
  api,
  workspace,
  routePending,
  onWorkspaceChange,
  playback,
  playbackPending,
  onPlaybackAction,
  onWorkspaceMutation,
  onSaveMetadata,
  transcriptStatus,
}: {
  api: Voice2TextDesktopApi;
  workspace: AudioWorkspaceSnapshot;
  routePending: boolean;
  onWorkspaceChange: (value: AudioWorkspaceSnapshot) => void;
  playback?: AudioPlaybackSnapshot | null;
  playbackPending?: boolean;
  onPlaybackAction?: (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => void;
  onWorkspaceMutation?: (
    action: WorkspaceMutationAction,
  ) => Promise<AudioWorkspaceSnapshot>;
  onSaveMetadata?: (
    patch: AudioMetadataPatch,
  ) => Promise<AudioWorkspaceSnapshot | null>;
  transcriptStatus?: React.ReactNode;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <WorkspaceView
      api={api}
      workspace={workspace}
      pending={pending || routePending}
      error={error}
      setPending={setPending}
      setError={setError}
      setWorkspace={onWorkspaceChange}
      externalPlayback={playback}
      externalPlaybackPending={playbackPending}
      onExternalPlaybackAction={onPlaybackAction}
      onWorkspaceMutation={onWorkspaceMutation}
      onSaveMetadata={onSaveMetadata}
      transcriptStatus={transcriptStatus}
    />
  );
}

function WorkspaceView({
  api,
  workspace,
  pending,
  error,
  setPending,
  setError,
  setWorkspace,
  onBack,
  externalPlayback,
  externalPlaybackPending,
  onExternalPlaybackAction,
  onWorkspaceMutation,
  onSaveMetadata,
  transcriptStatus,
}: {
  api: Voice2TextDesktopApi;
  workspace: AudioWorkspaceSnapshot;
  pending: boolean;
  error: string | null;
  setPending: (value: boolean) => void;
  setError: (value: string | null) => void;
  setWorkspace: (value: AudioWorkspaceSnapshot) => void;
  onBack?: () => void;
  externalPlayback?: AudioPlaybackSnapshot | null;
  externalPlaybackPending?: boolean;
  onExternalPlaybackAction?: (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => void;
  onWorkspaceMutation?: (
    action: WorkspaceMutationAction,
  ) => Promise<AudioWorkspaceSnapshot>;
  onSaveMetadata?: (
    patch: AudioMetadataPatch,
  ) => Promise<AudioWorkspaceSnapshot | null>;
  transcriptStatus?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [transcriptViewMode, setTranscriptViewMode] =
    React.useState<TranscriptViewMode>("flat");
  const [activeTab, setActiveTab] =
    React.useState<AudioWorkspaceTab>("transcript");
  const [title, setTitle] = React.useState(workspace.summary.displayName);
  const [description, setDescription] = React.useState(
    workspace.description ?? "",
  );
  const [editingField, setEditingField] = React.useState<
    "title" | "description" | null
  >(null);
  const editingFieldRef = React.useRef(editingField);
  const metadataDirtyRef = React.useRef({ title: false, description: false });
  const metadataVersionRef = React.useRef({ title: 0, description: 0 });
  const [metadataError, setMetadataError] = React.useState<string | null>(null);
  const [compactHeader, setCompactHeader] = React.useState(false);
  const observedCompactHeaderRef = React.useRef(false);
  const titleMarkerRef = React.useRef<HTMLDivElement>(null);
  const expandedTitleTriggerRef = React.useRef<HTMLButtonElement>(null);
  const expandedDescriptionTriggerRef = React.useRef<HTMLButtonElement>(null);
  const compactTitleTriggerRef = React.useRef<HTMLButtonElement>(null);
  const metadataFocusRestoreFieldRef = React.useRef<
    "title" | "description" | null
  >(null);
  const [playback, setPlayback] = React.useState<AudioPlaybackSnapshot | null>(
    null,
  );
  const [searchResults, setSearchResults] = React.useState<
    SearchResultIdentity[]
  >([]);
  const [activeSearchIndex, setActiveSearchIndex] = React.useState(-1);
  const operationPendingRef = React.useRef(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const playbackCloseRef = React.useRef<Promise<void> | null>(null);

  React.useEffect(() => {
    editingFieldRef.current = editingField;
    if (!editingField) {
      setCompactHeader(observedCompactHeaderRef.current);
    }
  }, [editingField]);

  React.useEffect(() => {
    const field = metadataFocusRestoreFieldRef.current;
    if (
      editingField ||
      !field ||
      pending ||
      compactHeader !== observedCompactHeaderRef.current
    ) {
      return;
    }
    const target = compactHeader
      ? compactTitleTriggerRef.current
      : field === "title"
        ? expandedTitleTriggerRef.current
        : expandedDescriptionTriggerRef.current;
    if (!target) return;
    metadataFocusRestoreFieldRef.current = null;
    target.focus();
  }, [compactHeader, editingField, pending]);

  React.useEffect(() => {
    if (!metadataDirtyRef.current.title) {
      setTitle(workspace.summary.displayName);
    }
    if (!metadataDirtyRef.current.description) {
      setDescription(workspace.description);
    }
  }, [workspace.description, workspace.summary.displayName]);

  React.useEffect(() => {
    const marker = titleMarkerRef.current;
    if (!marker || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const nextCompactHeader = !entry?.isIntersecting;
        observedCompactHeaderRef.current = nextCompactHeader;
        if (!editingFieldRef.current) setCompactHeader(nextCompactHeader);
      },
      { rootMargin: "-50px 0px 0px", threshold: 0 },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [workspace.summary.audioId]);

  React.useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const requestPlaybackClose = React.useCallback(() => {
    if (playbackCloseRef.current) return playbackCloseRef.current;
    const request = Promise.resolve(
      api.controlAudioPlayback(workspace.summary.audioId, { action: "close" }),
    ).then(() => undefined);
    playbackCloseRef.current = request;
    void request.catch(() => {
      if (playbackCloseRef.current === request) playbackCloseRef.current = null;
    });
    return request;
  }, [api, workspace.summary.audioId]);

  const closesPlaybackOnUnmount = onBack !== undefined;
  React.useEffect(() => {
    if (!closesPlaybackOnUnmount) return;
    return () => {
      void requestPlaybackClose().catch(() => undefined);
    };
  }, [closesPlaybackOnUnmount, requestPlaybackClose]);

  const closeAndGoBack = async () => {
    if (!onBack) return;
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await requestPlaybackClose();
      setPlayback(null);
      onBack();
    } catch (cause) {
      const detail = userFacingError(cause, "音频关闭未完成");
      setError(detail);
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  const selectSearchResult = (index: number) => {
    const result = searchResults[index];
    if (!result) return;
    setActiveSearchIndex(index);
  };

  const mutate = async (
    action: WorkspaceMutationAction,
  ): Promise<AudioWorkspaceSnapshot | null> => {
    if (operationPendingRef.current) return null;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const next = onWorkspaceMutation
        ? await onWorkspaceMutation(action)
        : await action(workspace);
      if (!onWorkspaceMutation) setWorkspace(next);
      if (!metadataDirtyRef.current.title) {
        setTitle(next.summary.displayName);
      }
      if (!metadataDirtyRef.current.description) {
        setDescription(next.description);
      }
      toast.dismiss("audio-workspace-mutation");
      return next;
    } catch (cause) {
      toast.error(userFacingError(cause, "音频修改未完成，请重新载入。"), {
        id: "audio-workspace-mutation",
      });
      return null;
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  const playbackAction = async (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      let current = playback;
      if (!current?.initialized && command.action !== "open") {
        current = await api.controlAudioPlayback(workspace.summary.audioId, {
          action: "open",
        });
      }
      const next =
        command.action === "open"
          ? current!
          : await api.controlAudioPlayback(workspace.summary.audioId, command);
      setPlayback(next);
      toast.dismiss("audio-playback-action");
    } catch (cause) {
      toast.error(userFacingError(cause, "音频操作未完成，请重试。"), {
        id: "audio-playback-action",
      });
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  const exportAudio = async (format: AudioExportFormat) => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.exportAudio(workspace.summary.audioId, format);
      if (result.state === "saved") {
        toast.success(`已导出 ${result.fileName}`, { id: "audio-export" });
      } else if (result.state === "canceled") {
        toast.dismiss("audio-export");
      } else {
        toast.error("音频导出失败，请重试。", { id: "audio-export" });
      }
    } catch (cause) {
      toast.error(userFacingError(cause, "音频导出未完成，请重试。"), {
        id: "audio-export",
      });
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  const saveMetadataField = (
    field: "title" | "description",
    explicitValue?: string,
  ) => {
    const draft = explicitValue ?? (field === "title" ? title : description);
    const value = field === "title" ? draft.trim() : draft;
    const authoritativeValue =
      field === "title" ? workspace.summary.displayName : workspace.description;
    if (value === authoritativeValue) {
      metadataDirtyRef.current[field] = false;
      return;
    }
    if (
      field === "title" &&
      value.length > audioWorkspaceLimits.titleCharacters
    ) {
      setMetadataError(
        `标题不能超过 ${audioWorkspaceLimits.titleCharacters} 个字符，请精简后重试。`,
      );
      return;
    }
    if (
      field === "description" &&
      value.length > audioWorkspaceLimits.descriptionCharacters
    ) {
      setMetadataError(
        `描述不能超过 ${audioWorkspaceLimits.descriptionCharacters} 个字符，请精简后重试。`,
      );
      return;
    }
    setMetadataError(null);
    const patch = { [field]: value } as AudioMetadataPatch;
    const version = metadataVersionRef.current[field];
    if (onSaveMetadata) {
      void onSaveMetadata(patch)
        .then((next) => {
          if (!next) return;
          if (metadataVersionRef.current[field] === version) {
            metadataDirtyRef.current[field] = false;
            if (field === "title") {
              setTitle(next.summary.displayName);
            } else {
              setDescription(next.description);
            }
          }
        })
        .catch((cause: unknown) => {
          toast.error(userFacingError(cause, "音频信息保存失败，请重试。"), {
            id: "audio-metadata-save",
          });
        });
      return;
    }
    void mutate((current) =>
      api.updateAudioMetadata({
        audioId: current.summary.audioId,
        ...patch,
        expectedRevision: current.revision,
      }),
    ).then((next) => {
      if (!next || metadataVersionRef.current[field] !== version) return;
      metadataDirtyRef.current[field] = false;
      if (field === "title") {
        setTitle(next.summary.displayName);
      } else {
        setDescription(next.description);
      }
    });
  };

  const commitMetadataEdit = (
    field: "title" | "description",
    value: string,
  ) => {
    metadataDirtyRef.current[field] = true;
    metadataVersionRef.current[field] += 1;
    if (field === "title") setTitle(value);
    else setDescription(value);
    saveMetadataField(field, value);
    setEditingField(null);
  };

  const requestMetadataFocusRestore = (field: "title" | "description") => {
    metadataFocusRestoreFieldRef.current = field;
  };

  const showEvidence = (
    evidence: { segmentId: number; startMs: number; endMs: number },
    generationId: number,
  ) => {
    setActiveTab("transcript");
    const segment = workspace.segments.find(
      (item) =>
        item.id === evidence.segmentId &&
        item.startMs === evidence.startMs &&
        item.endMs === evidence.endMs,
    );
    if (!segment) {
      setSearchResults([]);
      setActiveSearchIndex(-1);
      toast.warning("对应的转写片段已变化，请重新生成总结", {
        id: "audio-evidence-stale",
      });
      return;
    }
    if (workspace.summary.generationId !== generationId) {
      setSearchResults([]);
      setActiveSearchIndex(-1);
      toast.warning("对应的转写片段已变化，请重新生成总结", {
        id: "audio-evidence-stale",
      });
      return;
    }
    setSearchResults([
      {
        id: segment.id,
        stableKey: segment.stableKey,
        sequenceId: segment.sequenceId,
      },
    ]);
    setActiveSearchIndex(0);
  };

  const usesExternalPlayback = onExternalPlaybackAction !== undefined;
  const effectivePlayback = usesExternalPlayback ? externalPlayback : playback;
  const effectivePlaybackPending = usesExternalPlayback
    ? Boolean(externalPlaybackPending)
    : pending;
  const handlePlaybackAction = usesExternalPlayback
    ? onExternalPlaybackAction
    : (command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1]) =>
        void playbackAction(command);

  return (
    <section
      aria-label={`${workspace.summary.displayName} 工作区`}
      aria-busy={pending}
      className="min-h-full"
    >
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => void closeAndGoBack()}
        >
          返回音频列表
        </Button>
      ) : null}

      {error ? (
        <RecoveryError
          message={error}
          pending={pending}
          onRetry={() =>
            void mutate(async (current) => {
              const next = await api.openAudio(current.summary.audioId);
              if (!next) throw new Error("音频已不可用");
              return next;
            })
          }
        />
      ) : null}

      <div
        data-audio-sticky-actions
        className="pointer-events-none sticky top-0 z-30 mx-auto h-0 w-full max-w-5xl px-5 sm:px-8"
      >
        <div
          data-audio-sticky-actions-content
          className={
            compactHeader
              ? "pointer-events-auto ml-auto w-fit translate-y-[9px] transition-transform duration-200 motion-reduce:transition-none"
              : "pointer-events-auto ml-auto w-fit translate-y-8 transition-transform duration-200 motion-reduce:transition-none"
          }
        >
          <AudioWorkspaceActions
            pending={pending}
            onExport={(format) => void exportAudio(format)}
          />
        </div>
      </div>

      <div
        ref={titleMarkerRef}
        data-audio-hero
        className="mx-auto w-full max-w-5xl px-5 pt-8 sm:px-8"
      >
        <div
          data-audio-expanded-title
          aria-hidden={compactHeader}
          inert={compactHeader ? true : undefined}
          className={
            compactHeader
              ? "pointer-events-none pr-12 opacity-0 transition-opacity duration-200 motion-reduce:transition-none"
              : "pr-12 opacity-100 transition-opacity duration-200 motion-reduce:transition-none"
          }
        >
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">
              {editingField === "title" && !compactHeader ? (
                <InlineTextEditor
                  ariaLabel="音频标题"
                  initialValue={title}
                  className="block min-w-[1ch] max-w-full rounded-sm outline-none"
                  onCancel={() => setEditingField(null)}
                  onCommit={(value) => commitMetadataEdit("title", value)}
                  onKeyboardExit={() => requestMetadataFocusRestore("title")}
                />
              ) : (
                <button
                  ref={expandedTitleTriggerRef}
                  type="button"
                  aria-label="编辑音频标题"
                  className="max-w-full rounded-sm text-left outline-none focus-visible:underline focus-visible:underline-offset-2"
                  disabled={pending}
                  onClick={() => setEditingField("title")}
                >
                  {title.trim() || "未命名音频"}
                </button>
              )}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {editingField === "description" ? (
                <InlineTextEditor
                  ariaLabel="音频描述"
                  initialValue={description}
                  className="block min-h-5 w-full whitespace-nowrap rounded-sm outline-none"
                  onCancel={() => setEditingField(null)}
                  onCommit={(value) => commitMetadataEdit("description", value)}
                  onKeyboardExit={() =>
                    requestMetadataFocusRestore("description")
                  }
                />
              ) : (
                <button
                  ref={expandedDescriptionTriggerRef}
                  type="button"
                  aria-label="编辑音频描述"
                  className="rounded-sm text-left outline-none focus-visible:underline focus-visible:underline-offset-2"
                  disabled={pending}
                  onClick={() => setEditingField("description")}
                >
                  {description.trim() || "添加描述"}
                </button>
              )}
            </p>
            {metadataError ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {metadataError}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div
        data-audio-sticky-header
        className="sticky top-[50px] z-20 mt-5 h-11"
      >
        <div
          aria-hidden="true"
          className={
            compactHeader
              ? "pointer-events-none absolute inset-x-0 -top-[50px] h-[50px] bg-background/95 opacity-100 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none"
              : "pointer-events-none absolute inset-x-0 -top-[50px] h-[50px] bg-background/95 opacity-0 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none"
          }
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-11 border-b bg-background/95 backdrop-blur-sm"
        />
        <div className="relative mx-auto h-11 w-full max-w-5xl px-5 sm:px-8">
          <div
            data-audio-compact-title
            aria-hidden={!compactHeader}
            inert={!compactHeader ? true : undefined}
            className={
              compactHeader
                ? "absolute inset-x-5 -top-[35px] h-5 min-w-0 pr-12 text-sm leading-5 font-semibold opacity-100 transition-opacity duration-200 motion-reduce:transition-none sm:inset-x-8"
                : "pointer-events-none absolute inset-x-5 -top-[35px] h-5 min-w-0 pr-12 text-sm leading-5 font-semibold opacity-0 transition-opacity duration-200 motion-reduce:transition-none sm:inset-x-8"
            }
          >
            {editingField === "title" && compactHeader ? (
              <InlineTextEditor
                ariaLabel="音频标题"
                initialValue={title}
                className="block min-w-[1ch] max-w-full flex-1 truncate rounded-sm outline-none"
                onCancel={() => setEditingField(null)}
                onCommit={(value) => commitMetadataEdit("title", value)}
                onKeyboardExit={() => requestMetadataFocusRestore("title")}
              />
            ) : (
              <button
                ref={compactTitleTriggerRef}
                type="button"
                aria-label="编辑音频标题"
                className="block min-w-0 max-w-full truncate rounded-sm text-left outline-none focus-visible:underline focus-visible:underline-offset-2"
                disabled={pending}
                onClick={() => setEditingField("title")}
              >
                {title.trim() || "未命名音频"}
              </button>
            )}
          </div>
          <div
            role="tablist"
            aria-label="音频内容"
            className="relative flex h-11 translate-y-0 gap-6"
          >
            {audioWorkspaceTabs.map(({ value, label, icon: Icon }, index) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={activeTab === value}
                aria-controls={`audio-tab-${value}`}
                id={`audio-tab-trigger-${value}`}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                tabIndex={activeTab === value ? 0 : -1}
                className="flex h-11 items-center gap-1.5 border-b-2 border-transparent text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[active=true]:border-foreground data-[active=true]:text-foreground"
                data-active={activeTab === value}
                onClick={() => setActiveTab(value)}
                onKeyDown={(event) => {
                  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                  if (!keys.includes(event.key)) return;
                  event.preventDefault();
                  const nextIndex = nextTabIndex(event.key, index);
                  setActiveTab(audioWorkspaceTabs[nextIndex]!.value);
                  tabRefs.current[nextIndex]?.focus();
                }}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-8">
        <div
          id="audio-tab-transcript"
          role="tabpanel"
          aria-labelledby="audio-tab-trigger-transcript"
          hidden={activeTab !== "transcript"}
          className="space-y-4"
        >
          {workspace.segments.length === 0 ? (
            <FullScreenEmptyState
              description="当前音频尚未转写成文本"
              actions={transcriptStatus}
              className="min-h-96"
            />
          ) : (
            <>
              {transcriptStatus}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div
                  role="group"
                  aria-label="转写编辑操作"
                  className="flex gap-1"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending || !workspace.canUndo}
                    aria-label="撤销"
                    onClick={() =>
                      void mutate((current) =>
                        api.undoAudioEdit(
                          current.summary.audioId,
                          current.summary.generationId!,
                          current.revision,
                        ),
                      )
                    }
                  >
                    <Undo2 aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending || !workspace.canRedo}
                    aria-label="重做"
                    onClick={() =>
                      void mutate((current) =>
                        api.redoAudioEdit(
                          current.summary.audioId,
                          current.summary.generationId!,
                          current.revision,
                        ),
                      )
                    }
                  >
                    <Redo2 aria-hidden="true" />
                  </Button>
                </div>
                <form
                  role="search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      query.trim().length === 0 ||
                      operationPendingRef.current
                    )
                      return;
                    operationPendingRef.current = true;
                    setPending(true);
                    void api
                      .searchTranscript(workspace.summary.audioId, query)
                      .then((results) => {
                        const identities = results.map(
                          ({ id, stableKey, sequenceId }) => ({
                            id,
                            stableKey,
                            sequenceId,
                          }),
                        );
                        setSearchResults(identities);
                        setActiveSearchIndex(identities.length > 0 ? 0 : -1);
                        if (identities.length === 0) {
                          toast.info("没有找到匹配片段", {
                            id: "audio-transcript-search",
                          });
                        } else {
                          toast.dismiss("audio-transcript-search");
                        }
                      })
                      .catch((cause) =>
                        toast.error(userFacingError(cause, "搜索未完成"), {
                          id: "audio-transcript-search",
                        }),
                      )
                      .finally(() => {
                        operationPendingRef.current = false;
                        setPending(false);
                      });
                  }}
                >
                  <ButtonGroup aria-label="转写显示工具">
                    {searchOpen ? (
                      <Input
                        ref={searchInputRef}
                        type="search"
                        aria-label="搜索音频转写"
                        className="w-56"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setSearchOpen(false);
                          }
                        }}
                      />
                    ) : null}
                    <Button
                      type={searchOpen && query.trim() ? "submit" : "button"}
                      variant="outline"
                      size="icon-sm"
                      aria-label="搜索转写"
                      aria-pressed={searchOpen}
                      disabled={pending}
                      onClick={() => {
                        if (!searchOpen) setSearchOpen(true);
                      }}
                    >
                      <Search aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={
                        transcriptViewMode === "flat"
                          ? "切换为对话模式"
                          : "切换为平铺模式"
                      }
                      aria-pressed={transcriptViewMode === "conversation"}
                      onClick={() =>
                        setTranscriptViewMode((value) =>
                          value === "flat" ? "conversation" : "flat",
                        )
                      }
                    >
                      {transcriptViewMode === "flat" ? (
                        <MessagesSquare aria-hidden="true" />
                      ) : (
                        <Rows3 aria-hidden="true" />
                      )}
                    </Button>
                  </ButtonGroup>
                </form>
              </div>
              {searchResults.length > 0 ? (
                <div
                  role="group"
                  aria-label="搜索结果导航"
                  className="flex flex-wrap items-center justify-between gap-2 border-y py-2"
                >
                  <p className="text-sm text-muted-foreground">
                    搜索结果 {activeSearchIndex + 1} / {searchResults.length}
                    ，片段 {searchResults[activeSearchIndex]!.sequenceId + 1}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label="上一个搜索结果"
                      onClick={() =>
                        selectSearchResult(
                          (activeSearchIndex - 1 + searchResults.length) %
                            searchResults.length,
                        )
                      }
                    >
                      上一个
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label="下一个搜索结果"
                      onClick={() =>
                        selectSearchResult(
                          (activeSearchIndex + 1) % searchResults.length,
                        )
                      }
                    >
                      下一个
                    </Button>
                  </div>
                </div>
              ) : null}
              <VirtualTranscript
                workspace={workspace}
                pending={pending}
                viewMode={transcriptViewMode}
                activeSearchResult={searchResults[activeSearchIndex] ?? null}
                onEdit={(segment, text) =>
                  void mutate((current) =>
                    api.editAudioSegment({
                      audioId: current.summary.audioId,
                      generationId: current.summary.generationId!,
                      segmentId: segment.id,
                      text,
                      expectedRevision: current.revision,
                    }),
                  )
                }
                onAssign={(segment, state, speakerId) =>
                  void mutate((current) =>
                    api.assignAudioSpeaker({
                      audioId: current.summary.audioId,
                      generationId: current.summary.generationId!,
                      segmentId: segment.id,
                      state,
                      speakerId,
                      expectedRevision: current.revision,
                    }),
                  )
                }
              />
              <SpeakerPanel
                key={`${workspace.summary.generationId}:${workspace.speakers
                  .filter((speaker) => speaker.mergedIntoSpeakerId === null)
                  .map((speaker) => speaker.id)
                  .join(",")}`}
                api={api}
                workspace={workspace}
                pending={pending}
                mutate={mutate}
              />
            </>
          )}
        </div>

        <div
          id="audio-tab-summary"
          role="tabpanel"
          aria-labelledby="audio-tab-trigger-summary"
          hidden={activeTab !== "summary"}
        >
          {workspace.summary.generationId !== null ? (
            <AudioAiFeature
              key={`${workspace.summary.audioId}:${workspace.summary.generationId}`}
              api={api}
              audioId={workspace.summary.audioId}
              generationId={workspace.summary.generationId}
              onEvidenceSelect={(evidence) =>
                showEvidence(evidence, workspace.summary.generationId!)
              }
              onSuggestedTitle={(nextTitle) => {
                metadataDirtyRef.current.title = true;
                metadataVersionRef.current.title += 1;
                setTitle(nextTitle);
                saveMetadataField("title", nextTitle);
              }}
            />
          ) : (
            <EmptyState title="完成转写后即可生成 AI 总结" />
          )}
        </div>

        <div
          id="audio-tab-knowledge"
          role="tabpanel"
          aria-labelledby="audio-tab-trigger-knowledge"
          hidden={activeTab !== "knowledge"}
          className="grid min-h-80 place-items-center text-center"
        >
          <div>
            <HardDrive
              className="mx-auto size-7 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="mt-3 font-medium">知识库即将推出</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              之后可以在这里检索与当前音频相关的内容。
            </p>
          </div>
        </div>
      </div>
      {!usesExternalPlayback ? (
        <div className="sticky bottom-0 z-20 border-t bg-background">
          <AudioPlaybackControls
            playback={effectivePlayback}
            durationMs={workspace.summary.durationMs}
            pending={effectivePlaybackPending}
            onAction={handlePlaybackAction!}
          />
        </div>
      ) : null}
    </section>
  );
}

function VirtualTranscript({
  workspace,
  pending,
  viewMode,
  activeSearchResult,
  onEdit,
  onAssign,
}: {
  workspace: AudioWorkspaceSnapshot;
  pending: boolean;
  viewMode: TranscriptViewMode;
  activeSearchResult: SearchResultIdentity | null;
  onEdit: (segment: AudioSegment, text: string) => void;
  onAssign: (
    segment: AudioSegment,
    state: AudioSpeakerState,
    speakerId: number | null,
  ) => void;
}) {
  const [scrollTop, setScrollTop] = React.useState(0);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(
    workspace.segments.length,
    start + visibleRows + overscan * 2,
  );
  const visible = workspace.segments.slice(start, end);

  React.useEffect(() => {
    if (!activeSearchResult || !viewportRef.current) return;
    const nextScrollTop = activeSearchResult.sequenceId * rowHeight;
    viewportRef.current.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [activeSearchResult]);

  React.useEffect(() => {
    if (
      !activeSearchResult ||
      activeSearchResult.sequenceId < start ||
      activeSearchResult.sequenceId >= end
    )
      return;
    viewportRef.current
      ?.querySelector<HTMLElement>(
        `[data-segment-id="${activeSearchResult.id}"]`,
      )
      ?.focus();
  }, [activeSearchResult, end, start]);

  return (
    <div
      ref={viewportRef}
      className="h-[34rem] overflow-auto border-y"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      tabIndex={0}
      aria-label="可滚动音频转写"
    >
      <ul
        aria-label="音频转写片段"
        className="relative m-0 list-none p-0"
        style={{ height: workspace.segments.length * rowHeight }}
      >
        {visible.map((segment, visibleIndex) => (
          <SegmentRow
            key={`${segment.id}:${workspace.revision}`}
            segment={segment}
            speakers={workspace.speakers}
            pending={pending}
            viewMode={viewMode}
            top={(start + visibleIndex) * rowHeight}
            total={workspace.segments.length}
            onEdit={onEdit}
            onAssign={onAssign}
          />
        ))}
      </ul>
    </div>
  );
}

function SegmentRow({
  segment,
  speakers,
  pending,
  viewMode,
  top,
  total,
  onEdit,
  onAssign,
}: {
  segment: AudioSegment;
  speakers: AudioWorkspaceSnapshot["speakers"];
  pending: boolean;
  viewMode: TranscriptViewMode;
  top: number;
  total: number;
  onEdit: (segment: AudioSegment, text: string) => void;
  onAssign: (
    segment: AudioSegment,
    state: AudioSpeakerState,
    speakerId: number | null,
  ) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(segment.text);
  const index = segment.sequenceId + 1;
  const editorId = `segment-${segment.id}-text`;
  const speakerId = `segment-${segment.id}-speaker`;
  const save = () => {
    if (pending) return;
    const nextText = text.trim();
    if (nextText.length === 0 || nextText === segment.text) {
      setText(segment.text);
      setEditing(false);
      return;
    }
    onEdit(segment, nextText);
    setEditing(false);
  };
  const activeSpeakers = speakers.filter(
    (speaker) => speaker.mergedIntoSpeakerId === null,
  );
  const activeSpeakerIndex = activeSpeakers.findIndex(
    (speaker) => speaker.id === segment.speakerId,
  );
  const messageAlign =
    segment.speakerState === "assigned" && activeSpeakerIndex % 2 === 1
      ? "end"
      : "start";
  const speakerSelect = (
    <Select
      value={
        segment.speakerState === "assigned"
          ? `speaker:${segment.speakerId}`
          : segment.speakerState
      }
      disabled={pending}
      onValueChange={(value) => {
        if (value.startsWith("speaker:"))
          onAssign(segment, "assigned", Number(value.slice(8)));
        else onAssign(segment, value as "overlap" | "unknown", null);
      }}
    >
      <SelectTrigger
        id={speakerId}
        size="sm"
        aria-label={`片段 ${index} 说话人`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="unknown">未知说话人</SelectItem>
        <SelectItem value="overlap">多人重叠</SelectItem>
        {activeSpeakers.map((speaker) => (
          <SelectItem key={speaker.id} value={`speaker:${speaker.id}`}>
            {speaker.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const segmentEditor = (
    <div
      className={viewMode === "conversation" ? "flex gap-2" : "mt-2 flex gap-2"}
    >
      <Label htmlFor={editorId} className="sr-only">
        片段 {index} 文本
      </Label>
      <Textarea
        id={editorId}
        className={
          viewMode === "conversation"
            ? "field-sizing-fixed h-16 min-h-16 max-h-16 flex-1 resize-none overflow-y-auto"
            : "field-sizing-fixed h-20 min-h-20 max-h-20 flex-1 resize-none overflow-y-auto"
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          }
        }}
      />
      <Button
        type="button"
        size={viewMode === "conversation" ? "sm" : "default"}
        disabled={pending || text.trim().length === 0}
        onPointerDown={(event) => event.preventDefault()}
        onClick={save}
      >
        保存
      </Button>
    </div>
  );
  return (
    <li
      aria-label={`片段 ${index}，${clock(segment.startMs)} ${speakerLabel(segment)}`}
      aria-posinset={index}
      aria-setsize={total}
      data-segment-id={segment.id}
      tabIndex={-1}
      className="absolute right-0 left-0 border-b p-4"
      style={{ height: rowHeight, top }}
    >
      {viewMode === "conversation" ? (
        <Message align={messageAlign} className="h-full">
          <MessageAvatar>
            <Avatar size="sm">
              <AvatarFallback>{speakerAvatarLabel(segment)}</AvatarFallback>
            </Avatar>
          </MessageAvatar>
          <MessageContent className="gap-1.5">
            <MessageHeader className="justify-between gap-3">
              <span>
                {speakerLabel(segment)} · {clock(segment.startMs)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setEditing((value) => !value)}
              >
                编辑片段 {index}
              </Button>
            </MessageHeader>
            {editing ? (
              segmentEditor
            ) : (
              <Bubble variant="muted" className="h-16">
                <BubbleContent className="h-16 overflow-hidden">
                  {segment.text}
                </BubbleContent>
              </Bubble>
            )}
            <MessageFooter className="gap-2">
              <Label htmlFor={speakerId} className="sr-only">
                说话人
              </Label>
              {speakerSelect}
            </MessageFooter>
          </MessageContent>
        </Message>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-muted-foreground">
              {clock(segment.startMs)} · {speakerLabel(segment)}
              {segment.speakerSource === "manual" ? " · 已手工校正" : ""}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing((value) => !value)}
            >
              编辑片段 {index}
            </Button>
          </div>
          {editing ? (
            segmentEditor
          ) : (
            <p className="mt-2 h-20 line-clamp-3 text-sm leading-6">
              {segment.text}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Label
              htmlFor={speakerId}
              className="text-xs text-muted-foreground"
            >
              说话人
            </Label>
            {speakerSelect}
          </div>
        </>
      )}
    </li>
  );
}

function AudioWorkspaceActions({
  pending,
  onExport,
}: {
  pending: boolean;
  onExport: (format: AudioExportFormat) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label="音频操作"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label="导出"
          >
            <SquareArrowOutUpRight aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>选择导出格式</DropdownMenuLabel>
          {(["txt", "md", "vtt", "srt", "json"] as const).map((format) => (
            <DropdownMenuItem key={format} onSelect={() => onExport(format)}>
              {format.toUpperCase()}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AudioPlaybackControls({
  playback,
  durationMs,
  pending,
  onAction,
}: {
  playback: AudioPlaybackSnapshot | null | undefined;
  durationMs: number;
  pending: boolean;
  onAction: (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => void;
}) {
  const playing = playback?.playing ?? false;
  const positionMs = playback?.positionMs ?? 0;
  const resolvedDurationMs = Math.max(1, playback?.durationMs ?? durationMs);
  return (
    <section aria-label="音频播放器" className="w-full px-4 py-3 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl items-center gap-4 md:grid-cols-[auto_minmax(12rem,1fr)_auto]">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="播放控制"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label="后退 10 秒"
            onClick={() =>
              onAction({
                action: "seek",
                positionMs: Math.max(0, positionMs - 10_000),
              })
            }
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            disabled={pending}
            aria-label={playing ? "暂停音频" : "播放音频"}
            onClick={() => onAction({ action: playing ? "pause" : "play" })}
          >
            {playing ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label="前进 10 秒"
            onClick={() =>
              onAction({
                action: "seek",
                positionMs: Math.min(resolvedDurationMs, positionMs + 10_000),
              })
            }
          >
            <RotateCw aria-hidden="true" />
          </Button>
        </div>
        <div className="space-y-2">
          <div
            className="flex justify-between text-xs text-muted-foreground"
            aria-hidden="true"
          >
            <span>{clock(positionMs)}</span>
            <span>{clock(resolvedDurationMs)}</span>
          </div>
          <Slider
            aria-label="音频播放位置"
            aria-valuetext={clock(positionMs)}
            min={0}
            max={resolvedDurationMs}
            step={1}
            value={[positionMs]}
            disabled={pending}
            onValueChange={(value) =>
              onAction({ action: "seek", positionMs: value[0] ?? 0 })
            }
          />
        </div>
        <Select
          value={String(playback?.speed ?? 1)}
          disabled={pending}
          onValueChange={(value) =>
            onAction({ action: "speed", speed: Number(value) })
          }
        >
          <SelectTrigger aria-label="播放速度" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
              <SelectItem key={speed} value={String(speed)}>
                {speed}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

function SpeakerPanel({
  api,
  workspace,
  pending,
  mutate,
}: {
  api: Voice2TextDesktopApi;
  workspace: AudioWorkspaceSnapshot;
  pending: boolean;
  mutate: (action: WorkspaceMutationAction) => Promise<unknown>;
}) {
  const active = workspace.speakers.filter(
    (speaker) => speaker.mergedIntoSpeakerId === null,
  );
  const [names, setNames] = React.useState<Record<number, string>>(
    Object.fromEntries(
      active.map((speaker) => [speaker.id, speaker.displayName]),
    ),
  );
  const [target, setTarget] = React.useState(active[0]?.id ?? 0);
  const [source, setSource] = React.useState(active[1]?.id ?? 0);
  return (
    <section
      aria-labelledby="speakers-title"
      className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0"
    >
      <h2 id="speakers-title" className="font-semibold">
        说话人
      </h2>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚未识别说话人</p>
      ) : null}
      {active.map((speaker) => (
        <div key={speaker.id} className="flex gap-2">
          <Input
            aria-label={`${speaker.displayName} 名称`}
            value={names[speaker.id] ?? ""}
            onChange={(event) =>
              setNames((current) => ({
                ...current,
                [speaker.id]: event.target.value,
              }))
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || (names[speaker.id] ?? "").trim().length === 0}
            onClick={() =>
              void mutate((current) =>
                api.renameAudioSpeaker({
                  audioId: current.summary.audioId,
                  generationId: current.summary.generationId!,
                  speakerId: speaker.id,
                  name: names[speaker.id]!,
                  expectedRevision: current.revision,
                }),
              )
            }
          >
            重命名
          </Button>
        </div>
      ))}
      {active.length > 1 ? (
        <div className="space-y-2 border-t pt-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="speaker-merge-target"
              className="text-xs text-muted-foreground"
            >
              保留说话人
            </Label>
            <Select
              value={String(target)}
              onValueChange={(value) => setTarget(Number(value))}
            >
              <SelectTrigger
                id="speaker-merge-target"
                className="w-full"
                aria-label="合并目标说话人"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {active.map((speaker) => (
                  <SelectItem key={speaker.id} value={String(speaker.id)}>
                    {speaker.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="speaker-merge-source"
              className="text-xs text-muted-foreground"
            >
              合并来源
            </Label>
            <Select
              value={String(source)}
              onValueChange={(value) => setSource(Number(value))}
            >
              <SelectTrigger
                id="speaker-merge-source"
                className="w-full"
                aria-label="合并来源说话人"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {active.map((speaker) => (
                  <SelectItem key={speaker.id} value={String(speaker.id)}>
                    {speaker.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending || target === source || source === 0}
            onClick={() =>
              void mutate((current) =>
                api.mergeAudioSpeakers({
                  audioId: current.summary.audioId,
                  generationId: current.summary.generationId!,
                  targetSpeakerId: target,
                  sourceSpeakerIds: [source],
                  expectedRevision: current.revision,
                }),
              )
            }
          >
            合并说话人
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AudioLoading() {
  return (
    <section
      role="status"
      aria-label="正在载入音频资料库"
      className="grid min-h-64 place-items-center text-center"
    >
      <div>
        <h1 className="text-xl font-semibold">正在载入音频资料库</h1>
        <p className="mt-2 text-sm text-muted-foreground">正在读取本机音频。</p>
      </div>
    </section>
  );
}

function RecoveryError({
  message: detail,
  pending,
  onRetry,
}: {
  message: string;
  pending: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-y py-4"
    >
      <div>
        <p className="font-medium">音频工作区暂时不可用</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={onRetry}
      >
        {pending ? "正在重试…" : "重新载入"}
      </Button>
    </div>
  );
}

function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function nextTabIndex(key: string, current: number): number {
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return audioWorkspaceTabs.length - 1;
    case "ArrowRight":
      return (current + 1) % audioWorkspaceTabs.length;
    default:
      return (
        (current - 1 + audioWorkspaceTabs.length) % audioWorkspaceTabs.length
      );
  }
}

function speakerLabel(segment: AudioSegment): string {
  if (segment.speakerState === "overlap") return "多人重叠";
  if (segment.speakerState === "unknown") return "未知说话人";
  return segment.speakerName ?? "匿名说话人";
}

function speakerAvatarLabel(segment: AudioSegment): string {
  if (segment.speakerState === "overlap") return "多";
  if (segment.speakerState === "unknown") return "?";
  const label = segment.speakerName?.replaceAll(/\s/g, "");
  return label ? [...label].slice(0, 2).join("") : "匿名";
}

function processingLabel(state: AudioSummary["processingState"]): string {
  return {
    "not-started": "尚未转写",
    queued: "等待处理",
    running: "处理中",
    canceling: "正在取消",
    canceled: "已取消",
    interrupted: "已中断",
    completed: "可复核",
    failed: "处理失败",
    "partial-success": "部分成功，可复核",
  }[state];
}
