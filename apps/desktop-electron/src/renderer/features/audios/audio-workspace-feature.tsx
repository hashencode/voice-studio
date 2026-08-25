import * as React from "react";
import {
  ChevronDown,
  Download,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  RotateCw,
  Search,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type {
  AudioExportFormat,
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

type SearchResultIdentity = Pick<
  AudioSegment,
  "id" | "stableKey" | "sequenceId"
>;

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
  const [status, setStatus] = React.useState("正在载入音频资料库");
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
        setStatus(
          next.length === 0 ? "音频资料库为空" : `已载入 ${next.length} 个音频`,
        );
      } catch (cause) {
        setError(message(cause, "无法载入音频资料库"));
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
        setStatus(
          next.length === 0 ? "音频资料库为空" : `已载入 ${next.length} 个音频`,
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause, "无法载入音频资料库"));
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
      setStatus(`已打开 ${next.summary.displayName}`);
    } catch (cause) {
      setError(message(cause, "无法打开音频"));
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
          <div className="grid min-h-52 place-items-center border-y py-8 text-center">
            <div>
              <h2 className="text-lg font-semibold">还没有可复核的音频</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                导入并完成本地处理后，音频会出现在这里。
              </p>
            </div>
          </div>
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
                  className="w-full rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
        <LiveStatus status={status} />
      </section>
    );
  }

  return (
    <WorkspaceView
      api={api}
      workspace={workspace}
      pending={pending}
      error={error}
      status={status}
      setPending={setPending}
      setError={setError}
      setStatus={setStatus}
      setWorkspace={setWorkspace}
      onBack={() => {
        const audioId = workspace.summary.audioId;
        setWorkspace(null);
        setError(null);
        setStatus("已返回音频资料库");
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
}: {
  api: Voice2TextDesktopApi;
  workspace: AudioWorkspaceSnapshot;
  routePending: boolean;
  onWorkspaceChange: (value: AudioWorkspaceSnapshot) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState(
    `已打开 ${workspace.summary.displayName}`,
  );
  return (
    <WorkspaceView
      api={api}
      workspace={workspace}
      pending={pending || routePending}
      error={error}
      status={status}
      setPending={setPending}
      setError={setError}
      setStatus={setStatus}
      setWorkspace={onWorkspaceChange}
    />
  );
}

function WorkspaceView({
  api,
  workspace,
  pending,
  error,
  status,
  setPending,
  setError,
  setStatus,
  setWorkspace,
  onBack,
}: {
  api: Voice2TextDesktopApi;
  workspace: AudioWorkspaceSnapshot;
  pending: boolean;
  error: string | null;
  status: string;
  setPending: (value: boolean) => void;
  setError: (value: string | null) => void;
  setStatus: (value: string) => void;
  setWorkspace: (value: AudioWorkspaceSnapshot) => void;
  onBack?: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [playback, setPlayback] = React.useState<AudioPlaybackSnapshot | null>(
    null,
  );
  const [searchResults, setSearchResults] = React.useState<
    SearchResultIdentity[]
  >([]);
  const [activeSearchIndex, setActiveSearchIndex] = React.useState(-1);
  const operationPendingRef = React.useRef(false);
  const playbackCloseRef = React.useRef<Promise<void> | null>(null);

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
      const detail = message(cause, "音频关闭未完成");
      setError(detail);
      setStatus(`音频关闭失败：${detail}`);
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  const selectSearchResult = (index: number) => {
    const result = searchResults[index];
    if (!result) return;
    setActiveSearchIndex(index);
    setStatus(
      `搜索结果 ${index + 1} / ${searchResults.length}，片段 ${result.sequenceId + 1}`,
    );
  };

  const mutate = async (
    action: () => Promise<AudioWorkspaceSnapshot>,
    success: string,
  ) => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      setWorkspace(await action());
      setStatus(success);
    } catch (cause) {
      setError(message(cause, "音频修改未完成，请重新载入"));
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
      setStatus(playbackStatus(next));
    } catch (cause) {
      setError(message(cause, "音频操作未完成"));
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
      if (result.state === "saved") setStatus(`已导出 ${result.fileName}`);
      else if (result.state === "canceled") setStatus("已取消导出");
      else {
        setError(result.message);
        setStatus(`音频导出失败：${result.message}`);
      }
    } catch (cause) {
      setError(message(cause, "音频导出未完成"));
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <section
      aria-label={`${workspace.summary.displayName} 工作区`}
      aria-busy={pending}
      className="space-y-5"
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
            void mutate(async () => {
              const next = await api.openAudio(workspace.summary.audioId);
              if (!next) throw new Error("音频已不可用");
              return next;
            }, "已重新载入音频")
          }
        />
      ) : null}

      <AudioCommandDeck
        playback={playback}
        workspace={workspace}
        pending={pending}
        onAction={(command) => void playbackAction(command)}
        onUndo={() =>
          void mutate(
            () =>
              api.undoAudioEdit(
                workspace.summary.audioId,
                workspace.summary.generationId!,
                workspace.revision,
              ),
            "已撤销上次文本修改",
          )
        }
        onRedo={() =>
          void mutate(
            () =>
              api.redoAudioEdit(
                workspace.summary.audioId,
                workspace.summary.generationId!,
                workspace.revision,
              ),
            "已重做文本修改",
          )
        }
        onExport={(format) => void exportAudio(format)}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <form
            role="search"
            className="flex gap-2 border-y py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim().length === 0 || operationPendingRef.current)
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
                  setStatus(
                    identities.length === 0
                      ? "没有找到匹配片段"
                      : `搜索结果 1 / ${identities.length}，片段 ${identities[0]!.sequenceId + 1}`,
                  );
                })
                .catch((cause) => setError(message(cause, "搜索未完成")))
                .finally(() => {
                  operationPendingRef.current = false;
                  setPending(false);
                });
            }}
          >
            <Input
              type="search"
              aria-label="搜索音频转写"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={pending || query.trim().length === 0}
            >
              <Search aria-hidden="true" />
              搜索
            </Button>
          </form>
          {searchResults.length > 0 ? (
            <div
              role="group"
              aria-label="搜索结果导航"
              className="flex flex-wrap items-center justify-between gap-2 border-y py-2"
            >
              <p className="text-sm text-muted-foreground">
                搜索结果 {activeSearchIndex + 1} / {searchResults.length}，片段{" "}
                {searchResults[activeSearchIndex]!.sequenceId + 1}
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
          {workspace.segments.length === 0 ? (
            <div className="grid min-h-64 place-items-center border-y py-8 text-center">
              <div>
                <h2 className="font-semibold">转写尚未就绪</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  音频仍由本机保留；处理完成后可在这里复核。
                </p>
              </div>
            </div>
          ) : (
            <VirtualTranscript
              workspace={workspace}
              pending={pending}
              activeSearchResult={searchResults[activeSearchIndex] ?? null}
              onEdit={(segment, text) =>
                void mutate(
                  () =>
                    api.editAudioSegment({
                      audioId: workspace.summary.audioId,
                      generationId: workspace.summary.generationId!,
                      segmentId: segment.id,
                      text,
                      expectedRevision: workspace.revision,
                    }),
                  `已保存片段 ${segment.sequenceId + 1}`,
                )
              }
              onAssign={(segment, state, speakerId) =>
                void mutate(
                  () =>
                    api.assignAudioSpeaker({
                      audioId: workspace.summary.audioId,
                      generationId: workspace.summary.generationId!,
                      segmentId: segment.id,
                      state,
                      speakerId,
                      expectedRevision: workspace.revision,
                    }),
                  `已更新片段 ${segment.sequenceId + 1} 的说话人`,
                )
              }
            />
          )}
        </div>

        <aside aria-label="音频操作" className="space-y-4">
          {workspace.summary.generationId !== null ? (
            <AudioAiFeature
              key={`${workspace.summary.audioId}:${workspace.summary.generationId}`}
              api={api}
              audioId={workspace.summary.audioId}
              generationId={workspace.summary.generationId}
            />
          ) : null}
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
        </aside>
      </div>
      <LiveStatus status={status} />
    </section>
  );
}

function VirtualTranscript({
  workspace,
  pending,
  activeSearchResult,
  onEdit,
  onAssign,
}: {
  workspace: AudioWorkspaceSnapshot;
  pending: boolean;
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
  top,
  total,
  onEdit,
  onAssign,
}: {
  segment: AudioSegment;
  speakers: AudioWorkspaceSnapshot["speakers"];
  pending: boolean;
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
    if (text.trim().length === 0 || pending) return;
    onEdit(segment, text.trim());
    setEditing(false);
  };
  return (
    <li
      aria-label={`片段 ${index}，${clock(segment.startMs)} ${speakerLabel(segment)}`}
      aria-posinset={index}
      aria-setsize={total}
      data-segment-id={segment.id}
      tabIndex={-1}
      className="absolute left-0 right-0 border-b p-4"
      style={{ height: rowHeight, top }}
    >
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
        <div className="mt-2 flex gap-2">
          <Label htmlFor={editorId} className="sr-only">
            片段 {index} 文本
          </Label>
          <Textarea
            id={editorId}
            className="min-h-20 flex-1 resize-none"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
          <Button
            type="button"
            disabled={pending || text.trim().length === 0}
            onClick={save}
          >
            保存
          </Button>
        </div>
      ) : (
        <p className="mt-2 line-clamp-3 text-sm leading-6">{segment.text}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Label htmlFor={speakerId} className="text-xs text-muted-foreground">
          说话人
        </Label>
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
            {speakers
              .filter((speaker) => speaker.mergedIntoSpeakerId === null)
              .map((speaker) => (
                <SelectItem key={speaker.id} value={`speaker:${speaker.id}`}>
                  {speaker.displayName}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </li>
  );
}

function AudioCommandDeck({
  playback,
  workspace,
  pending,
  onAction,
  onUndo,
  onRedo,
  onExport,
}: {
  playback: AudioPlaybackSnapshot | null;
  workspace: Pick<AudioWorkspaceSnapshot, "summary" | "canUndo" | "canRedo">;
  pending: boolean;
  onAction: (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: (format: AudioExportFormat) => void;
}) {
  const playing = playback?.playing ?? false;
  const positionMs = playback?.positionMs ?? 0;
  const resolvedDurationMs = Math.max(
    1,
    playback?.durationMs ?? workspace.summary.durationMs,
  );
  return (
    <section
      aria-label="音频控制台"
      className="rounded-xl border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {workspace.summary.segmentCount} 个片段 ·{" "}
          {generationLabel(workspace.summary.generationKind)}
        </p>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="音频工作区操作"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={pending || !workspace.canUndo}
            aria-label="撤销"
            onClick={onUndo}
          >
            <Undo2 aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={pending || !workspace.canRedo}
            aria-label="重做"
            onClick={onRedo}
          >
            <Redo2 aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
              >
                <Download aria-hidden="true" />
                导出
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>选择导出格式</DropdownMenuLabel>
              {(["txt", "md", "vtt", "srt", "json"] as const).map((format) => (
                <DropdownMenuItem
                  key={format}
                  onSelect={() => onExport(format)}
                >
                  {format.toUpperCase()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-4 grid items-center gap-4 md:grid-cols-[auto_minmax(12rem,1fr)_auto]">
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
  mutate: (
    action: () => Promise<AudioWorkspaceSnapshot>,
    success: string,
  ) => Promise<void>;
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
              void mutate(
                () =>
                  api.renameAudioSpeaker({
                    audioId: workspace.summary.audioId,
                    generationId: workspace.summary.generationId!,
                    speakerId: speaker.id,
                    name: names[speaker.id]!,
                    expectedRevision: workspace.revision,
                  }),
                `已重命名 ${speaker.displayName}`,
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
              void mutate(
                () =>
                  api.mergeAudioSpeakers({
                    audioId: workspace.summary.audioId,
                    generationId: workspace.summary.generationId!,
                    targetSpeakerId: target,
                    sourceSpeakerIds: [source],
                    expectedRevision: workspace.revision,
                  }),
                "已合并说话人",
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
        <p className="mt-2 text-sm text-muted-foreground">
          正在读取 Electron 本机音频 authority。
        </p>
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

function LiveStatus({ status }: { status: string }) {
  return (
    <p
      role="status"
      aria-label="音频工作区状态"
      aria-live="polite"
      className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground"
    >
      {status}
    </p>
  );
}

function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function speakerLabel(segment: AudioSegment): string {
  if (segment.speakerState === "overlap") return "多人重叠";
  if (segment.speakerState === "unknown") return "未知说话人";
  return segment.speakerName ?? "匿名说话人";
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

function generationLabel(kind: AudioSummary["generationKind"]): string {
  if (kind === "formal") return "正式转写";
  if (kind === "live-draft") return "实时草稿";
  return "转写尚未就绪";
}

function playbackStatus(snapshot: AudioPlaybackSnapshot): string {
  if (!snapshot.initialized) return "音频已关闭";
  return snapshot.playing
    ? `正在播放，速度 ${snapshot.speed} 倍`
    : `已暂停在 ${clock(snapshot.positionMs)}`;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback;
}
