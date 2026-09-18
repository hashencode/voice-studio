import { Copy, MailOpen } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ActivityItem } from "@shared/contracts";

export type ActivityItemView = Pick<
  ActivityItem,
  | "id"
  | "kind"
  | "safeSummary"
  | "occurrenceCount"
  | "unread"
  | "settingsTarget"
  | "lastOccurredAt"
  | "diagnostic"
  | "sample"
>;

const formatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

const activityLabels: Record<
  ActivityItemView["kind"],
  { type: string; title: string }
> = {
  processing_runtime_unavailable: {
    type: "处理消息",
    title: "本地处理异常",
  },
  capture_runtime_unavailable: { type: "录制消息", title: "录制异常" },
  startup_reconciliation_failed: {
    type: "系统消息",
    title: "启动恢复异常",
  },
};

export function ActivityContextPane({
  items,
  selectedId,
  onSelect,
  operationError = null,
}: {
  items: ActivityItemView[];
  selectedId: string | null;
  onSelect: (item: ActivityItemView) => void;
  operationError?: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {operationError ? (
        <p role="alert" className="border-b px-3 py-2 text-sm">
          {operationError}
        </p>
      ) : null}
      {items.length === 0 ? (
        <EmptyState description="暂无消息" compact className="min-h-0 flex-1" />
      ) : (
        <ul aria-label="消息列表" data-flat-row-list="true">
          {items.map((item) => (
            <li key={item.id}>
              <Item
                asChild
                variant="context"
                size="context"
                className="text-left"
              >
                <button
                  type="button"
                  aria-current={selectedId === item.id ? "true" : undefined}
                  data-flat-row="true"
                  onClick={() => onSelect(item)}
                >
                  <ItemContent>
                    <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        {item.unread ? (
                          <Badge variant="dot" aria-label="未读" />
                        ) : null}
                        <span className="truncate">
                          {activityLabels[item.kind].type}
                        </span>
                        {item.sample ? (
                          <span className="text-muted-foreground">示例</span>
                        ) : null}
                      </span>
                      <time
                        dateTime={new Date(item.lastOccurredAt).toISOString()}
                        className="shrink-0 text-muted-foreground"
                      >
                        {dateFormatter.format(item.lastOccurredAt)}
                      </time>
                    </div>
                    <ItemTitle>{activityLabels[item.kind].title}</ItemTitle>
                    <ItemDescription className="line-clamp-2">
                      {item.safeSummary}
                    </ItemDescription>
                  </ItemContent>
                </button>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActivityContextPaneHead({
  unreadCount,
  markAllPending,
  onMarkAllRead,
}: {
  unreadCount: number;
  markAllPending: boolean;
  onMarkAllRead: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-7"
            aria-label="全部标记为已读"
            aria-busy={markAllPending}
            disabled={unreadCount === 0 || markAllPending}
            onClick={onMarkAllRead}
          >
            <MailOpen aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">全部标记为已读</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ActivityMainWorkspace({
  item,
  hasItems,
  onOpenSettingsTarget,
}: {
  item: ActivityItemView | null;
  hasItems: boolean;
  onOpenSettingsTarget: (item: ActivityItemView) => void;
}) {
  if (!item) {
    return hasItems ? (
      <EmptyState description="请选择左侧消息" className="flex-1" />
    ) : null;
  }
  const diagnostic = item.diagnostic;
  return (
    <section
      aria-label="消息详情"
      className="mx-auto w-full max-w-3xl space-y-8 py-8"
    >
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">错误概况</h2>
          <p className="text-sm text-muted-foreground">
            {activityLabels[item.kind].title}
            {item.sample ? " · 示例消息" : ""}
          </p>
        </div>
        <Card>
          <CardContent className="space-y-4">
            <p>{item.safeSummary}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">最近发生</dt>
              <dd>{formatter.format(item.lastOccurredAt)}</dd>
              <dt className="text-muted-foreground">发生次数</dt>
              <dd>{item.occurrenceCount}</dd>
            </dl>
            {item.settingsTarget ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenSettingsTarget(item)}
              >
                {settingsTargetLabel(item.settingsTarget)}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">错误原因</h2>
          <p className="text-sm text-muted-foreground">
            错误发生的环节和可用于定位的原因。
          </p>
        </div>
        <Card>
          <CardContent>
            {diagnostic ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">发生环节</dt>
                <dd>{diagnostic.stage}</dd>
                <dt className="text-muted-foreground">错误码</dt>
                <dd className="font-mono text-xs">{diagnostic.code}</dd>
                <dt className="text-muted-foreground">原因</dt>
                <dd>{diagnostic.reason}</dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                这条消息生成时未记录具体错误原因。
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {diagnostic ? (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">技术信息</h2>
            <p className="text-sm text-muted-foreground">
              将事件编号和诊断信息提供给开发者，可定位对应的错误记录。
            </p>
          </div>
          <Card>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">事件编号</dt>
                <dd className="break-all font-mono text-xs">
                  {diagnostic.eventId}
                </dd>
                <dt className="text-muted-foreground">应用版本</dt>
                <dd>{diagnostic.appVersion}</dd>
                {diagnostic.exceptionType ? (
                  <>
                    <dt className="text-muted-foreground">异常类型</dt>
                    <dd className="font-mono text-xs">
                      {diagnostic.exceptionType}
                    </dd>
                  </>
                ) : null}
              </dl>
              {diagnostic.stackFrames.length > 0 ? (
                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
                  {diagnostic.stackFrames
                    .map((frame) => `at ${frame}`)
                    .join("\n")}
                </pre>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyDiagnostic(item)}
              >
                <Copy aria-hidden="true" />
                复制诊断信息
              </Button>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </section>
  );
}

async function copyDiagnostic(item: ActivityItemView): Promise<void> {
  if (!item.diagnostic) return;
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          kind: item.kind,
          summary: item.safeSummary,
          diagnostic: item.diagnostic,
        },
        null,
        2,
      ),
    );
    toast.success("诊断信息已复制。");
  } catch {
    toast.error("无法复制诊断信息，请重试。");
  }
}

function settingsTargetLabel(
  target: NonNullable<ActivityItemView["settingsTarget"]>,
): string {
  if (target === "local-models") return "前往本地模型设置";
  if (target === "cloud-models") return "前往云端模型设置";
  if (target === "recording") return "前往录制设置";
  return "前往通用设置";
}
