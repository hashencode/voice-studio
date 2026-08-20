import * as React from "react";
import { Bell, CheckCircle2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ActivityItem } from "@shared/contracts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type ActivityItemView = Pick<
  ActivityItem,
  "id" | "title" | "severity" | "read" | "captureSessionId"
>;

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
  const unread = items.reduce((count, item) => count + Number(!item.read), 0);
  const newestAcknowledgeId = items.find((item) => !item.read)?.id;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen && newestAcknowledgeId) {
          onAcknowledgeThrough(newestAcknowledgeId);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={unread > 0 ? `消息，${unread} 条未读` : "消息"}
          className="relative"
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-white">
              {Math.min(unread, 20)}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="消息中心" className="overflow-hidden">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold">消息</h2>
          <p className="text-xs text-muted-foreground">需要关注的状态与操作</p>
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            暂无消息
          </p>
        ) : (
          <ul className="max-h-80 divide-y overflow-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    onOpenDetails(item);
                    setOpen(false);
                  }}
                >
                  {item.severity === "warning" ? (
                    <TriangleAlert
                      className="mt-0.5 size-4 shrink-0 text-amber-700"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-emerald-700"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 text-sm">{item.title}</span>
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
        )}
      </PopoverContent>
    </Popover>
  );
}
