import { BellOff, CheckCircle2, TriangleAlert } from "lucide-react";

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
}: {
  items: ActivityItemView[];
  selectedId: string | null;
  onSelect: (item: ActivityItemView) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={BellOff}
        title="暂无消息"
        description="录制完成、异常和需要处理的状态会显示在这里。"
        compact
      />
    );
  }
  return (
    <ul className="divide-y" aria-label="消息列表" data-flat-row-list="true">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-current={selectedId === item.id ? "true" : undefined}
            data-flat-row="true"
            className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:bg-accent aria-current:bg-accent"
            onClick={() => onSelect(item)}
          >
            <ActivityIcon severity={item.severity} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {item.title}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {formatter.format(item.createdAt)}
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
    return (
      <EmptyState
        icon={BellOff}
        title="请选择消息"
        description="选择左侧消息后，可在这里查看完整信息。"
      />
    );
  }
  return (
    <section aria-label="消息详情" className="mx-auto max-w-2xl py-8">
      <ActivityIcon severity={item.severity} large />
      <h2 className="mt-4 text-xl font-semibold">{item.title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {activityDescription(item)}
      </p>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-y py-4 text-sm">
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
