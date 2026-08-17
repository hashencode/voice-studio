import * as React from "react";
import { BrainCircuit, LoaderCircle, RotateCcw } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import type {
  AudioAiConsentPreview,
  AudioAiSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";

type RequestTarget =
  | { kind: "generate" }
  | { kind: "retry"; jobId: number; expectedAttempt: number };

export function AudioAiFeature({
  audioId,
  generationId,
  api = window.voice2text,
}: {
  audioId: number;
  generationId: number;
  api?: Voice2TextDesktopApi;
}) {
  const [snapshot, setSnapshot] = React.useState<AudioAiSnapshot | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<AudioAiConsentPreview | null>(
    null,
  );
  const [consentChecked, setConsentChecked] = React.useState(false);
  const [requestTarget, setRequestTarget] = React.useState<RequestTarget>({
    kind: "generate",
  });
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const accept = React.useCallback(
    (next: AudioAiSnapshot) => {
      if (next.audioId !== audioId || next.generationId !== generationId)
        return;
      setSnapshot((current) =>
        !current || isNewerSnapshot(current, next) ? next : current,
      );
    },
    [generationId, audioId],
  );

  React.useEffect(() => {
    let active = true;
    const unsubscribe = api.onAudioAiSnapshot((next) => {
      if (active) accept(next);
    });
    void api
      .getAudioAiSnapshot({ audioId })
      .then((next) => {
        if (active && next) accept(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, "无法读取会议智能草稿"));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, api, audioId]);

  const prepare = async (kind: RequestTarget["kind"]) => {
    if (pending) return;
    if (kind === "retry" && !snapshot) {
      setError("无法确定要重试的云端任务，请重新载入会议");
      return;
    }
    const target: RequestTarget =
      kind === "retry"
        ? {
            kind,
            jobId: snapshot!.jobId,
            expectedAttempt: snapshot!.attempt,
          }
        : { kind };
    setPending(true);
    setError(null);
    try {
      const next = await api.prepareAudioAi({
        audioId,
        generationId,
        templateId: "default",
      });
      setRequestTarget(target);
      setConsentChecked(false);
      setPreview(next);
    } catch (cause) {
      setError(aiErrorMessage(cause, "无法准备本次云端处理范围"));
    } finally {
      setPending(false);
    }
  };

  const submit = async () => {
    if (!preview || !consentChecked || pending) return;
    const consent = {
      version: 1 as const,
      providerId: preview.providerId,
      endpointOrigin: preview.endpointOrigin,
      endpointIdentitySha256: preview.endpointIdentitySha256,
      transcriptScopeSha256: preview.transcriptScopeSha256,
    };
    setPending(true);
    setError(null);
    setPreview(null);
    try {
      const next =
        requestTarget.kind === "retry"
          ? await api.retryAudioAi({
              jobId: requestTarget.jobId,
              expectedAttempt: requestTarget.expectedAttempt,
              idempotencyKey: requestIdentity("audio-ai-retry"),
              consent,
            })
          : await api.generateAudioAi({
              audioId,
              generationId,
              templateId: "default",
              idempotencyKey: requestIdentity("audio-ai-generate"),
              consent,
            });
      accept(next);
    } catch (cause) {
      setError(aiErrorMessage(cause, "云端会议草稿生成失败"));
    } finally {
      setConsentChecked(false);
      setPending(false);
    }
  };

  const buttonLabel =
    snapshot?.state === "completed"
      ? "重新生成云端会议草稿"
      : "生成云端会议草稿";
  const canRetry =
    snapshot?.state === "failed" || snapshot?.state === "interrupted";

  return (
    <section
      aria-labelledby="audio-ai-title"
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <BrainCircuit className="mt-0.5 size-5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="audio-ai-title" className="font-semibold">
            会议智能草稿
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            可选云端任务；不会发送音频、密钥、声纹或其他会议。
          </p>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-4 rounded-lg border px-3 py-2 text-sm">
          <p>{error}</p>
          <p className="mt-1 text-muted-foreground">
            当前提供商保持不变；不会自动切换提供商或重试。
          </p>
        </div>
      ) : null}

      {snapshot?.state === "queued" || snapshot?.state === "running" ? (
        <div role="status" className="mt-4 flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {snapshot.state === "queued"
            ? "云端草稿已排队"
            : "正在生成云端草稿"}{" "}
          · 第 {Math.max(1, snapshot.attempt)} 次尝试
        </div>
      ) : null}

      {snapshot?.state === "completed" && snapshot.note ? (
        <AudioAiNote snapshot={snapshot} />
      ) : null}

      {canRetry ? (
        <div role="alert" className="mt-4 rounded-lg border px-3 py-3 text-sm">
          <p>{snapshot.state === "interrupted" ? "生成已中断" : "生成失败"}</p>
          {snapshot.errorCode ? (
            <p className="mt-1 text-muted-foreground">{snapshot.errorCode}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {canRetry ? (
          <>
            <Button
              type="button"
              disabled={pending}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                void prepare("retry");
              }}
            >
              <RotateCcw aria-hidden="true" />
              重试云端会议草稿
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                void prepare("generate");
              }}
            >
              按当前内容重新生成云端会议草稿
            </Button>
          </>
        ) : (
          <Button
            type="button"
            disabled={pending}
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              void prepare("generate");
            }}
          >
            {buttonLabel}
          </Button>
        )}
      </div>

      <ConsentDialog
        preview={preview}
        checked={consentChecked}
        pending={pending}
        onCheckedChange={setConsentChecked}
        onCancel={() => {
          setPreview(null);
          setConsentChecked(false);
        }}
        onSubmit={() => void submit()}
        restoreFocus={() => triggerRef.current?.focus()}
      />
    </section>
  );
}

function ConsentDialog({
  preview,
  checked,
  pending,
  onCheckedChange,
  onCancel,
  onSubmit,
  restoreFocus,
}: {
  preview: AudioAiConsentPreview | null;
  checked: boolean;
  pending: boolean;
  onCheckedChange: (checked: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
  restoreFocus: () => void;
}) {
  return (
    <DialogPrimitive.Root
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-6 shadow-lg outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            本次会议云端处理同意
          </DialogPrimitive.Title>
          {preview ? (
            <>
              <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
                将会议标题“{preview.audioTitle}”以及本次会议的{" "}
                {preview.segmentCount}{" "}
                个转写片段、时间范围和匿名说话人状态发送给{" "}
                {providerLabel(preview.providerId)}。
                不会发送音频、密钥、声纹或其他会议。
              </DialogPrimitive.Description>
              <dl className="mt-4 grid gap-2 rounded-lg bg-muted p-3 text-sm">
                <div>
                  <dt className="font-medium">处理地址</dt>
                  <dd className="break-all text-muted-foreground">
                    {preview.endpointOrigin}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">转写范围</dt>
                  <dd className="text-muted-foreground">
                    {clock(preview.inputStartMs)}–{clock(preview.inputEndMs)} ·{" "}
                    {preview.segmentCount} 个转写片段
                  </dd>
                </div>
              </dl>
              <label className="mt-4 flex items-start gap-3 rounded-lg border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={checked}
                  onChange={(event) => onCheckedChange(event.target.checked)}
                />
                <span>我同意仅针对本次会议发送会议标题与上述转写文本</span>
              </label>
              <div className="mt-6 flex justify-end gap-2">
                <DialogPrimitive.Close asChild>
                  <Button type="button" variant="outline" disabled={pending}>
                    取消
                  </Button>
                </DialogPrimitive.Close>
                <Button
                  type="button"
                  disabled={pending || !checked}
                  onClick={onSubmit}
                >
                  同意并生成草稿
                </Button>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AudioAiNote({ snapshot }: { snapshot: AudioAiSnapshot }) {
  if (!snapshot.note) return null;
  return (
    <div className="mt-4 space-y-3" aria-label="云端会议草稿">
      <p className="text-xs text-muted-foreground">
        {providerLabel(snapshot.providerId)} · {snapshot.modelId} · 需要人工核对
      </p>
      <ul className="space-y-2">
        {snapshot.note.items.map((item) => (
          <li
            key={item.insightId}
            className="rounded-lg border px-3 py-3 text-sm"
          >
            <p className="font-medium">{item.body}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.evidence.length} 条转写证据
              {item.actionOwner ? ` · 负责人 ${item.actionOwner}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function isNewerSnapshot(
  current: AudioAiSnapshot,
  next: AudioAiSnapshot,
): boolean {
  if (next.jobId !== current.jobId) return next.jobId > current.jobId;
  if (next.attempt !== current.attempt) return next.attempt > current.attempt;
  return next.revision > current.revision;
}

function providerLabel(providerId: string): string {
  return providerId === "deepseek" ? "DeepSeek" : "OpenAI-compatible";
}

function aiErrorMessage(cause: unknown, fallback: string): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "";
  if (code.includes("SECRET_MISSING")) return "请先到设置输入提供商密钥";
  if (code.includes("SECRET_DENIED"))
    return "无法读取 macOS 钥匙串，请到设置重新输入密钥";
  if (code.includes("SECRET_CORRUPT"))
    return "macOS 钥匙串中的密钥无法使用，请到设置重新输入";
  return errorMessage(cause, fallback);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function requestIdentity(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${suffix}`;
}

function clock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
