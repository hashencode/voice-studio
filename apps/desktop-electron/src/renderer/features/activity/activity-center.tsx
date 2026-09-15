import * as React from "react";
import { MailOpen, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, FullScreenEmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  ContextPaneFilter,
  ContextPaneSearch,
} from "@/features/shell/context-pane-controls";
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

export type ActivityFilter = "all" | "unread";

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
  unreadCount = 0,
  markAllPending = false,
  operationError = null,
  onMarkAllRead = () => undefined,
  query: controlledQuery,
  filter: controlledFilter,
}: {
  items: ActivityItemView[];
  selectedId: string | null;
  onSelect: (item: ActivityItemView) => void;
  unreadCount?: number;
  markAllPending?: boolean;
  operationError?: string | null;
  onMarkAllRead?: () => void;
  query?: string;
  filter?: ActivityFilter;
}) {
  const [query, setQuery] = React.useState("");
  const effectiveQuery = controlledQuery ?? query;
  const effectiveFilter = controlledFilter ?? "all";
  const visibleItems = filterActivityItems(
    items,
    effectiveQuery,
    effectiveFilter,
  );
  const embeddedControls = controlledQuery === undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {embeddedControls ? (
        <div className="flex shrink-0 items-center gap-2 p-2">
          <ActivityContextPaneSearch value={query} onValueChange={setQuery} />
          <ActivityContextPaneHead
            unreadCount={unreadCount}
            markAllPending={markAllPending}
            onMarkAllRead={onMarkAllRead}
          />
        </div>
      ) : null}
      {operationError ? (
        <p role="alert" className="border-b px-3 py-2 text-sm">
          {operationError}
        </p>
      ) : null}
      {visibleItems.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? "暂无消息" : "没有匹配的消息"}
          compact
          className="min-h-0 flex-1"
        />
      ) : (
        <ul aria-label="消息列表" data-flat-row-list="true">
          {visibleItems.map((item) => (
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

export function ActivityContextPaneSearch({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <ContextPaneSearch
      aria-label="搜索消息"
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    />
  );
}

export function ActivityContextPaneFilters({
  items,
  value,
  onValueChange,
}: {
  items: readonly ActivityItemView[];
  value: ActivityFilter;
  onValueChange: (value: ActivityFilter) => void;
}) {
  const filters: readonly { value: ActivityFilter; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "unread", label: "未读" },
  ];
  const counts: Record<ActivityFilter, number> = {
    all: items.length,
    unread: items.filter((item) => item.unread).length,
  };
  return (
    <div
      role="group"
      aria-label="消息筛选"
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
    >
      {filters.map((item) => (
        <ContextPaneFilter
          key={item.value}
          label={item.label}
          count={counts[item.value]}
          aria-pressed={value === item.value}
          onClick={() => onValueChange(item.value)}
        />
      ))}
    </div>
  );
}

function filterActivityItems(
  items: readonly ActivityItemView[],
  query: string,
  filter: ActivityFilter,
): ActivityItemView[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return items.filter((item) => {
    const matchesQuery =
      !normalizedQuery ||
      item.safeSummary.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    const matchesFilter = filter === "all" || item.unread;
    return matchesQuery && matchesFilter;
  });
}

export function ActivityMainWorkspace({
  item,
  onOpenSettingsTarget,
}: {
  item: ActivityItemView | null;
  onOpenSettingsTarget: (item: ActivityItemView) => void;
}) {
  if (!item) {
    return (
      <FullScreenEmptyState
        title="还没有消息"
        description="这里只显示需要跨页面关注的应用错误。"
      />
    );
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
