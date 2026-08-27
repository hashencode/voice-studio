import * as React from "react";
import { AlertCircle, LoaderCircle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import type {
  LocalModelBundleSnapshot,
  LocalModelIntent,
  LocalModelSnapshot,
} from "@shared/contracts";
import {
  SettingsItemGroup,
  SettingsListBlock,
  SettingsListSkeleton,
} from "@/features/settings/settings-page-section";

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

  if (!snapshot) {
    if (error) {
      return (
        <SettingsListBlock
          role="alert"
          className="flex items-start gap-2 p-4 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </SettingsListBlock>
      );
    }
    return <SettingsListSkeleton rows={3} />;
  }

  const operation = snapshot.operation;
  return (
    <section aria-label="本地模型设置" className="w-full">
      {error ? (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <SettingsItemGroup>
        {operation ? (
          <>
            <Item role="listitem" aria-live="polite" className="rounded-none">
              <ItemContent className="gap-3">
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
                  <ItemActions>
                    {operation.kind === "download" && operation.bundleId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void act({
                            action:
                              operation.message === "已暂停"
                                ? "resume"
                                : "pause",
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
                      size="sm"
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
                  </ItemActions>
                ) : operation.kind === "cleanup" ? (
                  <Button
                    className="mt-3"
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void act({ action: "retry-cleanup" })}
                  >
                    重试清理
                  </Button>
                ) : null}
              </ItemContent>
            </Item>
            <ItemSeparator />
          </>
        ) : null}

        <ModelRow
          name="Worker Runtime"
          state={snapshot.runtime.state === "ready" ? "正常" : "已损坏"}
          detail={snapshot.runtime.message}
        />
        {snapshot.bundles.map((bundle) => (
          <React.Fragment key={bundle.id}>
            <ItemSeparator />
            <ModelRow
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
                    size="sm"
                    disabled={pending || operation !== null}
                    onClick={() =>
                      void act({ action: "redownload", bundleId: bundle.id })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    删除并重新下载
                  </Button>
                ) : bundle.state === "installed" ||
                  bundle.state === "corrupt" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
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
                    size="sm"
                    disabled={pending || operation !== null}
                    onClick={() =>
                      void act({ action: "download", bundleId: bundle.id })
                    }
                  >
                    {pending ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    下载
                  </Button>
                ) : null
              }
            />
          </React.Fragment>
        ))}
      </SettingsItemGroup>
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
    <Item role="listitem" className="rounded-none">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{detail}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="text-sm text-muted-foreground">{state}</span>
        {action}
      </ItemActions>
    </Item>
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
