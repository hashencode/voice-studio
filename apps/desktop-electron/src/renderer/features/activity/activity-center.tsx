import * as React from "react";
import { CheckCircle2, MailOpen, Search, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { SidebarInput } from "@/components/ui/sidebar";
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
  | "title"
  | "severity"
  | "read"
  | "captureSessionId"
  | "createdAt"
>;

export type ActivityFilter = "all" | "unread" | "attention";

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
        <ul
          className="divide-y"
          aria-label="消息列表"
          data-flat-row-list="true"
        >
          {visibleItems.map((item) => (
            <li key={item.id}>
              <Item
                asChild
                size="sm"
                className="w-full rounded-none border-0 text-left hover:bg-accent aria-current:bg-muted"
              >
                <button
                  type="button"
                  aria-current={selectedId === item.id ? "true" : undefined}
                  data-flat-row="true"
                  onClick={() => onSelect(item)}
                >
                  <ItemMedia variant="icon">
                    <ActivityIcon severity={item.severity} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="max-w-full truncate">
                      {item.title}
                    </ItemTitle>
                    <ItemDescription>
                      {formatter.format(item.createdAt)}
                    </ItemDescription>
                  </ItemContent>
                  {!item.read ? (
                    <ItemActions>
                      <span
                        className="size-2 rounded-full bg-primary"
                        aria-label="未读"
                      />
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
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2.5 size-4 text-muted-foreground"
      />
      <SidebarInput
        type="search"
        aria-label="搜索消息"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        className="h-7 rounded-md pl-8 text-xs md:text-xs"
      />
    </div>
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
    { value: "attention", label: "需处理" },
  ];
  const counts: Record<ActivityFilter, number> = {
    all: items.length,
    unread: items.filter((item) => !item.read).length,
    attention: items.filter((item) => item.severity === "warning").length,
  };
  return (
    <div role="group" aria-label="消息筛选" className="flex items-center gap-1">
      {filters.map((item) => (
        <Button
          key={item.value}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={value === item.value}
          className="h-6 rounded-md px-2 text-xs aria-pressed:bg-muted aria-pressed:font-medium"
          onClick={() => onValueChange(item.value)}
        >
          {item.label} {counts[item.value]}
        </Button>
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
      item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    const matchesFilter =
      filter === "all" ||
      (filter === "unread" ? !item.read : item.severity === "warning");
    return matchesQuery && matchesFilter;
  });
}

export function ActivityMainWorkspace({
  item,
  onOpenDetails,
}: {
  item: ActivityItemView | null;
  onOpenDetails: (item: ActivityItemView) => void;
}) {
  if (!item) {
    return <EmptyState title="请选择消息" className="min-h-0 flex-1" />;
  }
  return (
    <section aria-label="消息详情" className="mx-auto max-w-2xl py-8">
      <ActivityIcon severity={item.severity} large />
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-y py-4 text-sm">
        <dt className="text-muted-foreground">时间</dt>
        <dd>{formatter.format(item.createdAt)}</dd>
        <dt className="text-muted-foreground">状态</dt>
        <dd>{item.severity === "warning" ? "需要处理" : "已完成"}</dd>
      </dl>
      <Button
        type="button"
        className="mt-6"
        onClick={() => onOpenDetails(item)}
      >
        打开录制详情
      </Button>
    </section>
  );
}

export function ActivityErrorDialog({
  item,
  open,
  onOpenChange,
  onOpenDetails,
}: {
  item: ActivityItemView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDetails: (item: ActivityItemView) => void;
}) {
  if (!item) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="错误信息">
        <DialogHeader>
          <DialogTitle>{item.title}</DialogTitle>
          <DialogDescription>{activityDescription(item)}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              稍后处理
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => onOpenDetails(item)}>
            打开录制详情
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActivityIcon({
  severity,
  large = false,
}: {
  severity: ActivityItemView["severity"];
  large?: boolean;
}) {
  const Icon = severity === "warning" ? TriangleAlert : CheckCircle2;
  return (
    <Icon
      className={`${large ? "size-7" : "mt-0.5 size-4 shrink-0"} ${severity === "warning" ? "text-amber-700" : "text-emerald-700"}`}
      aria-hidden="true"
    />
  );
}

function activityDescription(item: ActivityItemView): string {
  switch (item.kind) {
    case "capture_failed":
      return "这次录制未完成。请打开详情选择恢复方式。";
    case "capture_partial":
      return "只保存了部分音频。请打开详情检查。";
    case "capture_completed":
      return "录制已保存。";
  }
}
