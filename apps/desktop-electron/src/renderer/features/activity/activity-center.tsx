import * as React from "react";
import { Bell, BellOff, CheckCircle2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActivityItem } from "@shared/contracts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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

const activityTimestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function ActivityCenter({
  items,
  onAcknowledgeThrough,
  onOpenDetails,
}: {
  items: ActivityItemView[];
  onAcknowledgeThrough: (id: string) => void;
  onOpenDetails: (item: ActivityItemView) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const unread = items.reduce((count, item) => count + Number(!item.read), 0);
  const newestAcknowledgeId = items.find((item) => !item.read)?.id;
  const selected =
    items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setSelectedId(items[0]?.id ?? null);
        if (nextOpen && newestAcknowledgeId) {
          onAcknowledgeThrough(newestAcknowledgeId);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={unread > 0 ? `消息，${unread} 条未读` : "消息"}
          className="relative size-8"
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-white">
              {unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="消息中心"
        side="right"
        align="end"
        sideOffset={10}
        className="w-[min(42rem,calc(100vw-4rem))] overflow-hidden"
      >
        {items.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title="暂无消息"
            description="录制完成、异常和需要处理的状态会显示在这里。"
            compact
          />
        ) : (
          <div className="grid min-h-80 grid-cols-[minmax(13rem,2fr)_minmax(17rem,3fr)]">
            <div className="min-w-0 border-r">
              <div className="border-b px-4 py-3">
                <h2 className="font-semibold">消息</h2>
                <p className="text-xs text-muted-foreground">状态摘要</p>
              </div>
              <ul
                className="max-h-80 divide-y overflow-auto"
                aria-label="消息列表"
              >
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={
                        selected?.id === item.id ? "true" : undefined
                      }
                      className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:bg-accent aria-current:bg-accent"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <ActivityIcon severity={item.severity} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {item.title}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {formatCreatedAt(item.createdAt)}
                        </span>
                      </span>
                      {!item.read ? (
                        <span
                          className="mt-1.5 size-2 rounded-full bg-primary"
                          aria-label="未读"
                        />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {selected ? (
              <section
                aria-label="消息详情"
                className="flex min-w-0 flex-col p-5"
              >
                <ActivityIcon severity={selected.severity} large />
                <h3 className="mt-4 font-semibold">{selected.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {activityDescription(selected)}
                </p>
                <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">时间</dt>
                  <dd>{formatCreatedAt(selected.createdAt)}</dd>
                  <dt className="text-muted-foreground">状态</dt>
                  <dd>
                    {selected.severity === "warning" ? "需要处理" : "已完成"}
                  </dd>
                </dl>
                <Button
                  type="button"
                  className="mt-auto self-start"
                  onClick={() => {
                    onOpenDetails(selected);
                    setOpen(false);
                  }}
                >
                  打开录制详情
                </Button>
              </section>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
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
      className={`${large ? "size-6" : "mt-0.5 size-4 shrink-0"} ${
        severity === "warning" ? "text-amber-700" : "text-emerald-700"
      }`}
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

function formatCreatedAt(createdAt: number): string {
  return activityTimestampFormatter.format(createdAt);
}
