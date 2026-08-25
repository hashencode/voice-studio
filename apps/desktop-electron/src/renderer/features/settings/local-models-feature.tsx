import * as React from "react";
import { AlertCircle, FolderOpen, LoaderCircle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  LocalModelBundleSnapshot,
  LocalModelIntent,
  LocalModelSnapshot,
} from "@shared/contracts";

const STATE_LABELS: Record<LocalModelBundleSnapshot["state"], string> = {
  "not-installed": "未安装",
  downloading: "下载中",
  paused: "已暂停",
  installing: "安装中",
  installed: "已安装",
  failed: "失败",
  corrupt: "已损坏",
  "storage-unavailable": "位置不可用",
};

const PHASE_LABELS = {
  preparing: "准备迁移",
  copying: "复制模型",
  verifying: "校验副本",
  switching: "切换位置",
  probing: "探测模型",
  cleaning: "清理旧位置",
  "cleanup-required": "等待清理旧位置",
  completed: "迁移完成",
  canceled: "迁移已取消",
  "recovery-required": "需要恢复模型位置",
} as const;

export function LocalModelsFeature() {
  const [snapshot, setSnapshot] = React.useState<LocalModelSnapshot | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void window.voice2text
      .getLocalModelSnapshot()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    const unsubscribe = window.voice2text.onLocalModelSnapshot((next) => {
      if (active) setSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const act = React.useCallback(
    async (intent: Omit<LocalModelIntent, "expectedRevision">) => {
      if (!snapshot || pending) return;
      setPending(true);
      setError(null);
      try {
        setSnapshot(
          await window.voice2text.sendLocalModelIntent({
            ...intent,
            expectedRevision: snapshot.revision,
          } as LocalModelIntent),
        );
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [pending, snapshot],
  );

  const changeRoot = React.useCallback(async () => {
    if (!snapshot || pending) return;
    setPending(true);
    setError(null);
    try {
      setSnapshot(
        await window.voice2text.changeLocalModelRoot({
          expectedRevision: snapshot.revision,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [pending, snapshot]);

  if (!snapshot) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在读取本地模型…
      </p>
    );
  }

  const operation = snapshot.operation;
  return (
    <section
      aria-labelledby="local-models-heading"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
    >
      <div>
        <h2 id="local-models-heading" className="text-lg font-semibold">
          本地模型
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          录音和导入不依赖模型。转写与实时字幕仅在你主动使用时检查对应模型。
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="border-y py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-medium">模型位置</h3>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {snapshot.storage.displayPath}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!snapshot.canChangeRoot || pending}
            onClick={() => void changeRoot()}
          >
            <FolderOpen aria-hidden="true" />
            更换位置
          </Button>
        </div>
        {!snapshot.canChangeRoot ? (
          <p className="mt-2 text-xs text-muted-foreground">
            模型操作、迁移、Worker 使用或处理任务存在时不能更换位置。
          </p>
        ) : null}
      </div>

      {operation ? (
        <div role="status" aria-live="polite" className="border p-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              {operation.phase
                ? PHASE_LABELS[operation.phase]
                : (operation.message ?? "正在处理模型")}
            </span>
            {operation.totalBytes > 0 ? (
              <span>
                {formatBytes(operation.copiedBytes)} /{" "}
                {formatBytes(operation.totalBytes)}
              </span>
            ) : null}
          </div>
          {operation.totalBytes > 0 ? (
            <Progress
              className="mt-3"
              value={operation.copiedBytes}
              max={operation.totalBytes}
            />
          ) : null}
          {operation.cancelable ? (
            <div className="mt-3 flex gap-2">
              {operation.kind === "download" && operation.bundleId ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void act({
                      action:
                        operation.message === "已暂停" ? "resume" : "pause",
                      bundleId: operation.bundleId!,
                    })
                  }
                >
                  {operation.message === "已暂停" ? "继续" : "暂停"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void act({
                    action:
                      operation.kind === "migration"
                        ? "cancel-migration"
                        : "cancel",
                    ...(operation.bundleId
                      ? { bundleId: operation.bundleId }
                      : {}),
                  } as Omit<LocalModelIntent, "expectedRevision">)
                }
              >
                取消
              </Button>
            </div>
          ) : operation.kind === "cleanup" ? (
            <Button
              className="mt-3"
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void act({ action: "retry-cleanup" })}
            >
              重试清理
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="divide-y border-y">
        <ModelRow
          name="Worker Runtime"
          state={snapshot.runtime.state === "ready" ? "正常" : "已损坏"}
          detail={snapshot.runtime.message}
        />
        {snapshot.bundles.map((bundle) => (
          <ModelRow
            key={bundle.id}
            name={bundle.displayName}
            state={STATE_LABELS[bundle.state]}
            detail={
              bundle.message ??
              (bundle.version
                ? `版本 ${bundle.version}`
                : bundle.distributionEligible
                  ? "可下载安装"
                  : "正式下载尚未开放")
            }
            action={
              bundle.state === "corrupt" && bundle.distributionEligible ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || operation !== null}
                  onClick={() =>
                    void act({ action: "redownload", bundleId: bundle.id })
                  }
                >
                  <Trash2 aria-hidden="true" />
                  删除并重新下载
                </Button>
              ) : bundle.state === "installed" || bundle.state === "corrupt" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || operation !== null}
                  onClick={() =>
                    void act({ action: "delete", bundleId: bundle.id })
                  }
                >
                  <Trash2 aria-hidden="true" />
                  删除
                </Button>
              ) : bundle.distributionEligible ? (
                <Button
                  type="button"
                  disabled={pending || operation !== null}
                  onClick={() =>
                    void act({ action: "download", bundleId: bundle.id })
                  }
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : null}
                  下载
                </Button>
              ) : null
            }
          />
        ))}
      </div>
    </section>
  );
}

function ModelRow({
  name,
  state,
  detail,
  action,
}: {
  name: string;
  state: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="font-medium">{name}</h3>
          <span className="text-xs text-muted-foreground">{state}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "本地模型操作失败";
}
