import { MailOpen, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
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
>;

const formatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

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
                  <ItemMedia variant="icon">
                    <ActivityIcon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.safeSummary}</ItemTitle>
                    <ItemDescription>
                      {item.occurrenceCount > 1
                        ? `发生 ${item.occurrenceCount} 次 · `
                        : ""}
                      {formatter.format(item.lastOccurredAt)}
                    </ItemDescription>
                  </ItemContent>
                  {item.unread ? (
                    <ItemActions>
                      <Badge variant="dot" aria-label="未读" />
                    </ItemActions>
                  ) : null}
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
  return (
    <section aria-label="消息详情" className="mx-auto max-w-2xl py-8">
      <ActivityIcon large />
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-y py-4 text-sm">
        <dt className="text-muted-foreground">最近发生</dt>
        <dd>{formatter.format(item.lastOccurredAt)}</dd>
        <dt className="text-muted-foreground">发生次数</dt>
        <dd>{item.occurrenceCount}</dd>
        <dt className="text-muted-foreground">状态</dt>
        <dd>需要处理</dd>
      </dl>
      {item.settingsTarget ? (
        <Button
          type="button"
          className="mt-6"
          onClick={() => onOpenSettingsTarget(item)}
        >
          {settingsTargetLabel(item.settingsTarget)}
        </Button>
      ) : null}
    </section>
  );
}

function ActivityIcon({ large = false }: { large?: boolean }) {
  return (
    <TriangleAlert
      className={`${large ? "size-7" : "mt-0.5 size-4 shrink-0"} text-amber-700`}
      aria-hidden="true"
    />
  );
}

function settingsTargetLabel(
  target: NonNullable<ActivityItemView["settingsTarget"]>,
): string {
  if (target === "local-models") return "前往本地模型设置";
  if (target === "cloud-models") return "前往云端模型设置";
  if (target === "recording") return "前往录制设置";
  return "前往通用设置";
}
