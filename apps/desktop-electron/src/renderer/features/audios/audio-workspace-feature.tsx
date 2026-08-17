import * as React from "react";
import { Download, Pause, Play, Redo2, Search, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [status, setStatus] = React.useState("正在载入会议资料库");
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
          next.length === 0 ? "会议资料库为空" : `已载入 ${next.length} 个会议`,
        );
      } catch (cause) {
        setError(message(cause, "无法载入会议资料库"));
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
          next.length === 0 ? "会议资料库为空" : `已载入 ${next.length} 个会议`,
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause, "无法载入会议资料库"));
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
      if (!next) throw new Error("会议不存在或已被移除");
      setWorkspace(next);
      setStatus(`已打开 ${next.summary.displayName}`);
    } catch (cause) {
      setError(message(cause, "无法打开会议"));
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
          <p className="text-sm font-medium text-muted-foreground">本机会议</p>
          <h1
            id="audio-library-title"
            className="text-2xl font-semibold tracking-tight"
          >
            会议资料库
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
            aria-label="搜索会议资料库"
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
          <div className="grid min-h-52 place-items-center rounded-xl border bg-card p-8 text-center">
            <div>
              <h2 className="text-lg font-semibold">还没有可复核的会议</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                导入并完成本地处理后，会议会出现在这里。
              </p>
            </div>
          </div>
        ) : (
          <ul
            aria-label="会议列表"
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
        setStatus("已返回会议资料库");
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>(`[data-audio-id="${audioId}"]`)
            ?.focus();
        });
      }}
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
  onBack: () => void;
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
    const request = api
      .controlAudioPlayback(workspace.summary.audioId, { action: "close" })
      .then(() => undefined);
    playbackCloseRef.current = request;
    void request.catch(() => {
      if (playbackCloseRef.current === request) playbackCloseRef.current = null;
    });
    return request;
  }, [api, workspace.summary.audioId]);

  React.useEffect(
    () => () => {
      void requestPlaybackClose().catch(() => undefined);
    },
    [requestPlaybackClose],
  );

  const closeAndGoBack = async () => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await requestPlaybackClose();
      setPlayback(null);
      onBack();
    } catch (cause) {
      const detail = message(cause, "会议音频关闭未完成");
      setError(detail);
      setStatus(`会议音频关闭失败：${detail}`);
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
      setError(message(cause, "会议修改未完成，请重新载入"));
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
      setError(message(cause, "会议音频操作未完成"));
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
        setStatus(`会议导出失败：${result.message}`);
      }
    } catch (cause) {
      setError(message(cause, "会议导出未完成"));
    } finally {
      operationPendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <section
      aria-labelledby="audio-title"
      aria-busy={pending}
      className="space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void closeAndGoBack()}
          >
            返回资料库
          </Button>
          <h1
            id="audio-title"
            className="mt-2 text-2xl font-semibold tracking-tight"
          >
            {workspace.summary.displayName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {workspace.summary.segmentCount} 个片段 ·{" "}
            {generationLabel(workspace.summary.generationKind)}
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="编辑历史">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !workspace.canUndo}
            onClick={() =>
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
          >
            <Undo2 aria-hidden="true" />
            撤销
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending || !workspace.canRedo}
            onClick={() =>
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
          >
            <Redo2 aria-hidden="true" />
            重做
          </Button>
        </div>
      </div>

      {error ? (
        <RecoveryError
          message={error}
          pending={pending}
          onRetry={() =>
            void mutate(async () => {
              const next = await api.openAudio(workspace.summary.audioId);
              if (!next) throw new Error("会议已不可用");
              return next;
            }, "已重新载入会议")
          }
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <form
            role="search"
            className="flex gap-2 rounded-xl border bg-card p-3"
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
              aria-label="搜索会议转写"
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
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2"
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
            <div className="grid min-h-64 place-items-center rounded-xl border bg-card p-8 text-center">
              <div>
                <h2 className="font-semibold">转写尚未就绪</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  会议音频仍由本机保留；处理完成后可在这里复核。
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

        <aside aria-label="会议操作" className="space-y-4">
          {workspace.summary.generationId !== null ? (
            <AudioAiFeature
              key={`${workspace.summary.audioId}:${workspace.summary.generationId}`}
              api={api}
              audioId={workspace.summary.audioId}
              generationId={workspace.summary.generationId}
            />
          ) : null}
          <PlaybackPanel
            playback={playback}
            durationMs={workspace.summary.durationMs}
            pending={pending}
            onAction={(command) => void playbackAction(command)}
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
          <ExportPanel
            pending={pending}
            onExport={(format) => void exportAudio(format)}
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
      className="h-[34rem] overflow-auto rounded-xl border bg-card"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      tabIndex={0}
      aria-label="可滚动会议转写"
    >
      <ul
        aria-label="会议转写片段"
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
          <textarea
            aria-label={`片段 ${index} 文本`}
            className="min-h-20 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>说话人</span>
        <select
          aria-label={`片段 ${index} 说话人`}
          className="rounded-md border bg-background px-2 py-1 text-foreground"
          disabled={pending}
          value={
            segment.speakerState === "assigned"
              ? `speaker:${segment.speakerId}`
              : segment.speakerState
          }
          onChange={(event) => {
            const value = event.target.value;
            if (value.startsWith("speaker:"))
              onAssign(segment, "assigned", Number(value.slice(8)));
            else onAssign(segment, value as "overlap" | "unknown", null);
          }}
        >
          <option value="unknown">未知说话人</option>
          <option value="overlap">多人重叠</option>
          {speakers
            .filter((speaker) => speaker.mergedIntoSpeakerId === null)
            .map((speaker) => (
              <option key={speaker.id} value={`speaker:${speaker.id}`}>
                {speaker.displayName}
              </option>
            ))}
        </select>
      </label>
    </li>
  );
}

function PlaybackPanel({
  playback,
  durationMs,
  pending,
  onAction,
}: {
  playback: AudioPlaybackSnapshot | null;
  durationMs: number;
  pending: boolean;
  onAction: (
    command: Parameters<Voice2TextDesktopApi["controlAudioPlayback"]>[1],
  ) => void;
}) {
  const playing = playback?.playing ?? false;
  return (
    <section
      aria-labelledby="playback-title"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 id="playback-title" className="font-semibold">
        会议音频
      </h2>
      <Button
        type="button"
        className="w-full"
        disabled={pending}
        aria-label={playing ? "暂停会议音频" : "播放会议音频"}
        onClick={() => onAction({ action: playing ? "pause" : "play" })}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        {playing ? "暂停" : "播放"}
      </Button>
      <label className="block text-xs text-muted-foreground">
        播放位置 {clock(playback?.positionMs ?? 0)}
        <input
          aria-label="会议音频播放位置"
          className="mt-2 w-full"
          type="range"
          min={0}
          max={Math.max(1, playback?.durationMs ?? durationMs)}
          value={playback?.positionMs ?? 0}
          disabled={pending}
          onChange={(event) =>
            onAction({ action: "seek", positionMs: Number(event.target.value) })
          }
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>播放速度</span>
        <select
          aria-label="播放速度"
          className="rounded-md border bg-background px-2 py-1 text-foreground"
          value={playback?.speed ?? 1}
          disabled={pending}
          onChange={(event) =>
            onAction({ action: "speed", speed: Number(event.target.value) })
          }
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
      </label>
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
      className="space-y-3 rounded-xl border bg-card p-4"
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
          <label className="block text-xs text-muted-foreground">
            保留说话人
            <select
              aria-label="合并目标说话人"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground"
              value={target}
              onChange={(event) => setTarget(Number(event.target.value))}
            >
              {active.map((speaker) => (
                <option key={speaker.id} value={speaker.id}>
                  {speaker.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            合并来源
            <select
              aria-label="合并来源说话人"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground"
              value={source}
              onChange={(event) => setSource(Number(event.target.value))}
            >
              {active.map((speaker) => (
                <option key={speaker.id} value={speaker.id}>
                  {speaker.displayName}
                </option>
              ))}
            </select>
          </label>
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

function ExportPanel({
  pending,
  onExport,
}: {
  pending: boolean;
  onExport: (format: AudioExportFormat) => void;
}) {
  return (
    <section
      aria-labelledby="export-title"
      className="rounded-xl border bg-card p-4"
    >
      <h2 id="export-title" className="font-semibold">
        导出
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(["txt", "md", "vtt", "srt", "json"] as const).map((format) => (
          <Button
            key={format}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label={`导出 ${format.toUpperCase()}`}
            onClick={() => onExport(format)}
          >
            <Download aria-hidden="true" />
            {format.toUpperCase()}
          </Button>
        ))}
      </div>
    </section>
  );
}

function AudioLoading() {
  return (
    <section
      role="status"
      aria-label="正在载入会议资料库"
      className="grid min-h-64 place-items-center text-center"
    >
      <div>
        <h1 className="text-xl font-semibold">正在载入会议资料库</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          正在读取 Electron 本机会议 authority。
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
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"
    >
      <div>
        <p className="font-medium">会议工作区暂时不可用</p>
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
      aria-label="会议工作区状态"
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
  if (!snapshot.initialized) return "会议音频已关闭";
  return snapshot.playing
    ? `正在播放，速度 ${snapshot.speed} 倍`
    : `已暂停在 ${clock(snapshot.positionMs)}`;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback;
}
