import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FileClock,
  PenLine,
  RotateCcw,
  Waves,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  CaptionFormalRetryRequest,
  CaptionSnapshot,
  CaptionSnapshotRequest,
} from "@shared/contracts";

interface CaptionWorkspaceProps {
  sessionId: string;
  getSnapshot: (
    request: CaptionSnapshotRequest,
  ) => Promise<CaptionSnapshot | null>;
  subscribe: (listener: (snapshot: CaptionSnapshot) => void) => () => void;
  retryFormal: (request: CaptionFormalRetryRequest) => Promise<CaptionSnapshot>;
}

const LIVE_ANNOUNCEMENT_DELAY_MS = 750;
const CAPTION_BACKLOG_LIMIT_BYTES = 960_000;

export function CaptionWorkspace({
  sessionId,
  getSnapshot,
  subscribe,
  retryFormal,
}: CaptionWorkspaceProps) {
  const [snapshot, setSnapshot] = React.useState<CaptionSnapshot | null>(null);
  const [loadFailure, setLoadFailure] = React.useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const [retryPendingIdentity, setRetryPendingIdentity] = React.useState<
    string | null
  >(null);
  const [retryFailure, setRetryFailure] = React.useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = React.useState<{
    sessionId: string;
    value: string;
  } | null>(null);
  const activeSessionRef = React.useRef(sessionId);
  const pendingRetriesRef = React.useRef(new Set<string>());

  const accept = React.useCallback((next: CaptionSnapshot) => {
    if (next.sessionId !== activeSessionRef.current) return;
    setSnapshot((current) =>
      current && !isNewerCaptionSnapshot(current, next) ? current : next,
    );
  }, []);

  React.useEffect(() => {
    let active = true;
    activeSessionRef.current = sessionId;

    const unsubscribe = subscribe((next) => {
      if (active) accept(next);
    });
    void getSnapshot({ sessionId })
      .then((restored) => {
        if (!active || activeSessionRef.current !== sessionId) return;
        if (restored) accept(restored);
      })
      .catch((reason: unknown) => {
        if (active && activeSessionRef.current === sessionId) {
          setLoadFailure({
            sessionId,
            message: errorMessage(reason, "无法恢复实时字幕状态"),
          });
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, getSnapshot, sessionId, subscribe]);

  const visibleSnapshot = snapshot?.sessionId === sessionId ? snapshot : null;
  const loadError =
    loadFailure?.sessionId === sessionId ? loadFailure.message : null;
  const retryError =
    retryFailure?.sessionId === sessionId ? retryFailure.message : null;
  const latestUtterance = visibleSnapshot?.draft?.utterances.at(-1) ?? null;
  const announcementIdentity = latestUtterance
    ? `${visibleSnapshot?.draft?.generationId}:${visibleSnapshot?.draft?.attempt}:${latestUtterance.sequence}`
    : null;
  const latestUtteranceText = latestUtterance?.text ?? "";
  React.useEffect(() => {
    if (!latestUtteranceText || !announcementIdentity) return;
    const timer = window.setTimeout(() => {
      setAnnouncement({
        sessionId,
        value: `最新实时草稿：${latestUtteranceText}`,
      });
    }, LIVE_ANNOUNCEMENT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [announcementIdentity, latestUtteranceText, sessionId]);

  const retry = React.useCallback(() => {
    if (!visibleSnapshot) return;
    const expectedAttempt = visibleSnapshot.formal.attempt;
    const identity = `${visibleSnapshot.sessionId}:${expectedAttempt}`;
    if (pendingRetriesRef.current.has(identity)) return;
    pendingRetriesRef.current.add(identity);
    setRetryPendingIdentity(identity);
    setRetryFailure(null);
    void retryFormal({
      sessionId: visibleSnapshot.sessionId,
      expectedAttempt,
      idempotencyKey: formalRetryKey(
        visibleSnapshot.sessionId,
        expectedAttempt,
      ),
    })
      .then(accept)
      .catch((reason: unknown) => {
        if (activeSessionRef.current === visibleSnapshot.sessionId) {
          setRetryFailure({
            sessionId: visibleSnapshot.sessionId,
            message: errorMessage(reason, "无法重试正式转写"),
          });
        }
      })
      .finally(() => {
        pendingRetriesRef.current.delete(identity);
        setRetryPendingIdentity((current) =>
          current === identity ? null : current,
        );
      });
  }, [accept, retryFormal, visibleSnapshot]);

  const retryPending =
    retryPendingIdentity?.startsWith(`${sessionId}:`) ?? false;

  if (!visibleSnapshot && !loadError) return null;

  return (
    <section
      role="region"
      aria-label="实时字幕与转写"
      aria-busy={retryPending}
      className="space-y-3 border-y py-3"
    >
      <span
        data-testid="caption-live-announcement"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement?.sessionId === sessionId ? announcement.value : ""}
      </span>
      {loadError ? (
        <div role="alert" className="flex gap-2 text-sm">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>{loadError}；录音继续且权威音频不受影响。</p>
        </div>
      ) : null}
      {visibleSnapshot ? (
        <>
          {visibleSnapshot.draft ? (
            <DraftTranscript draft={visibleSnapshot.draft} />
          ) : null}
          <FormalTranscript
            snapshot={visibleSnapshot}
            retryPending={retryPending}
            retryError={retryError}
            onRetry={retry}
          />
          <ManualTranscript authority={visibleSnapshot.displayAuthority} />
        </>
      ) : null}
    </section>
  );
}

function DraftTranscript({
  draft,
}: {
  draft: NonNullable<CaptionSnapshot["draft"]>;
}) {
  const transcript = draft.utterances
    .map((utterance) => utterance.text.trim())
    .filter(Boolean)
    .join(" ");
  const copy = React.useCallback(() => {
    if (!transcript || !navigator.clipboard) return;
    void navigator.clipboard.writeText(transcript).catch(() => undefined);
  }, [transcript]);
  return (
    <article aria-labelledby="caption-draft-heading" className="space-y-2">
      <div className="flex items-start gap-2">
        <Waves className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id="caption-draft-heading" className="text-sm font-semibold">
            实时草稿 · 可能变化
          </h3>
          <p className="text-xs text-muted-foreground">
            SenseVoice · {draftStateLabel(draft.state)}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!transcript}
          onClick={copy}
          aria-label="复制字幕"
        >
          <Clipboard aria-hidden="true" />
          复制
        </Button>
      </div>
      {draft.state === "degraded" ? (
        <div
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm"
        >
          <p className="font-medium">实时草稿已降级</p>
          <p className="mt-1">
            {captionErrorLabel(draft.errorCode)}；录音继续且权威音频不受影响。
          </p>
        </div>
      ) : null}
      <div
        aria-label="实时草稿内容"
        tabIndex={0}
        className="max-h-40 space-y-1 overflow-auto rounded-md bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {draft.hasEarlierUtterances ? (
          <p className="text-xs text-muted-foreground">更早字幕已安全保存</p>
        ) : null}
        {draft.utterances.length > 0 ? (
          draft.utterances.map((utterance) => (
            <p
              key={`${draft.generationId}-${draft.attempt}-${utterance.sequence}`}
            >
              {utterance.text}
            </p>
          ))
        ) : (
          <p className="text-muted-foreground">
            等待第一句完整实时草稿；不会展示未结束的 token partial。
          </p>
        )}
      </div>
      {draft.backlogBytes > 0 ? (
        <div className="space-y-1">
          <div className="flex justify-between gap-3 text-xs">
            <span id="caption-backlog-label" className="font-medium">
              实时草稿积压
            </span>
            <span>{draft.backlogBytes.toLocaleString("en-US")} 字节</span>
          </div>
          <Progress
            aria-labelledby="caption-backlog-label"
            aria-valuetext={`字幕处理积压 ${draft.backlogBytes.toLocaleString("en-US")} 字节`}
            max={CAPTION_BACKLOG_LIMIT_BYTES}
            value={Math.min(draft.backlogBytes, CAPTION_BACKLOG_LIMIT_BYTES)}
          />
        </div>
      ) : null}
    </article>
  );
}

function FormalTranscript({
  snapshot,
  retryPending,
  retryError,
  onRetry,
}: {
  snapshot: CaptionSnapshot;
  retryPending: boolean;
  retryError: string | null;
  onRetry: () => void;
}) {
  const formal = snapshot.formal;
  const failed = formal.state === "failed" || formal.state === "interrupted";
  return (
    <article
      aria-labelledby="caption-formal-heading"
      className="space-y-2 border-t pt-3"
    >
      <div className="flex items-start gap-2">
        <FileClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id="caption-formal-heading" className="text-sm font-semibold">
            正式转写 · Qwen3
          </h3>
          <p className="text-xs text-muted-foreground">
            {formalStateLabel(formal.state, formal.attempt)}
          </p>
        </div>
        {formal.state === "completed" ? (
          <CheckCircle2 className="size-4" aria-label="正式转写已完成" />
        ) : null}
      </div>
      {failed ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
        >
          <p className="font-medium">正式转写失败；实时草稿仍保留且未被覆盖</p>
          <p className="mt-1">
            {formalErrorLabel(formal.errorCode)}。重试会创建新的独立尝试。
          </p>
        </div>
      ) : null}
      {retryError ? <p role="alert">{retryError}</p> : null}
      {failed ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retryPending}
            onClick={onRetry}
          >
            <RotateCcw aria-hidden="true" />
            {retryPending ? "正在重试正式转写" : "重试正式转写"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ManualTranscript({
  authority,
}: {
  authority: CaptionSnapshot["displayAuthority"];
}) {
  return (
    <article className="flex items-start gap-2 border-t pt-3">
      <PenLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>
        <h3 className="text-sm font-semibold">人工修订 · 独立保留</h3>
        <p className="text-xs text-muted-foreground">
          {authority === "manual" || authority === "revision_required"
            ? "当前展示包含人工修订；机器生成不会静默覆盖。"
            : "人工修改会保留独立来源与修订历史。"}
        </p>
      </div>
    </article>
  );
}

function isNewerCaptionSnapshot(
  current: CaptionSnapshot,
  next: CaptionSnapshot,
): boolean {
  if (next.sessionId !== current.sessionId) return true;
  if (next.revision <= current.revision) return false;
  if (current.draft && !next.draft) return false;
  if (current.draft && next.draft) {
    if (next.draft.generationId < current.draft.generationId) return false;
    if (
      next.draft.generationId === current.draft.generationId &&
      next.draft.attempt < current.draft.attempt
    )
      return false;
  }
  return next.formal.attempt >= current.formal.attempt;
}

function formalRetryKey(sessionId: string, attempt: number): string {
  return `formal-retry-${sessionId}-${attempt + 1}`;
}

function draftStateLabel(
  state: NonNullable<CaptionSnapshot["draft"]>["state"],
): string {
  return {
    preparing: "正在准备",
    running: "正在生成",
    paused: "已暂停",
    flushing: "正在收尾",
    flushed: "草稿已保存",
    degraded: "已降级",
  }[state];
}

function formalStateLabel(
  state: CaptionSnapshot["formal"]["state"],
  attempt: number,
): string {
  return {
    not_queued: "录音安全提交后才会排队",
    queued: `正式转写已排队 · 第 ${attempt} 次尝试`,
    running: `正在生成正式转写 · 第 ${attempt} 次尝试`,
    completed: `正式转写已完整发布 · 第 ${attempt} 次尝试`,
    failed: `正式转写失败 · 第 ${attempt} 次尝试`,
    interrupted: `正式转写已中断 · 第 ${attempt} 次尝试`,
  }[state];
}

function captionErrorLabel(code: string | null): string {
  return (
    {
      CAPTION_BACKLOG_EXCEEDED: "字幕积压超过安全上限",
      WORKER_START_FAILED: "字幕 worker 启动失败",
      WORKER_EVENT_FAILED: "字幕 worker 事件流中断",
      WORKER_FLUSH_FAILED: "字幕草稿收尾失败",
    }[code ?? ""] ?? `字幕服务暂不可用${code ? `（${code}）` : ""}`
  );
}

function formalErrorLabel(code: string | null): string {
  return code ? `正式转写错误（${code}）` : "正式转写未完整发布";
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
