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
}: {
  items: ActivityItemView[];
  selectedId: string | null;
  onSelect: (item: ActivityItemView) => void;
  unreadCount?: number;
  markAllPending?: boolean;
  operationError?: string | null;
  onMarkAllRead?: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = normalizedQuery
    ? items.filter((item) =>
        item.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
      )
    : items;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 p-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          />
          <SidebarInput
            type="search"
            aria-label="搜索消息"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="pl-8"
          />
        </div>
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
      </div>
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
      return "这次录制未能正常完成，需要打开详情选择恢复或保留现有音频。";
    case "capture_partial":
      return "这次录制只保存了部分音频，需要打开详情确认内容是否完整。";
    case "capture_completed":
      return "这次录制已经安全保存，可以打开详情继续复核或处理转写结果。";
  }
}
