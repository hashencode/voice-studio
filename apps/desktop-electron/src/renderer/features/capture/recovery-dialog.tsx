import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CaptureRecoveryItem } from "@shared/contracts";
import { recoveryReasonMessage } from "./capture-presentation";

export type RecoveryDialogState =
  | "assessing"
  | "choice"
  | "pending-restore"
  | "pending-ignore"
  | "result"
  | "hidden";

export function RecoveryDialog({
  state,
  items,
  restoredCount,
  onRestore,
  onIgnore,
  onAcknowledge,
  onRequestFocusFallback,
}: {
  state: RecoveryDialogState;
  items: CaptureRecoveryItem[];
  restoredCount: number;
  onRestore: () => void;
  onIgnore: () => void;
  onAcknowledge: () => void;
  onRequestFocusFallback: () => void;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const open = state !== "assessing" && state !== "hidden";
  const pending = state === "pending-restore" || state === "pending-ignore";
  const restorableCount = items.filter(
    (item) => item.capability === "restorable",
  ).length;
  const discardableCount = items.filter(
    (item) => item.capability === "discard-only",
  ).length;
  const preservedCount = items.filter(
    (item) => item.capability === "preserve-only",
  ).length;
  const discardTargetCount = restorableCount + discardableCount;

  const requestClose = React.useCallback(() => {
    if (pending) return;
    if (discardTargetCount > 0) onIgnore();
    else onAcknowledge();
  }, [discardTargetCount, onAcknowledge, onIgnore, pending]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={!pending}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRequestFocusFallback();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {state === "result" ? "恢复结果" : "发现待处理的录音"}
          </DialogTitle>
          <DialogDescription>
            {state === "result"
              ? `${restoredCount} 段录音已恢复并保存。`
              : `发现 ${items.length} 段待处理录音：${restorableCount} 段可恢复，${discardableCount} 段可忽略，${preservedCount} 段需要保留。忽略或关闭只会删除可丢弃的数据；暂时无法验证的数据会继续保留。`}
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <p className="border-y bg-muted/40 py-3 text-sm font-medium">
            {state === "pending-restore" ? "正在恢复…" : "正在忽略…"}
          </p>
        ) : null}

        {items.some((item) => item.reason !== null) ? (
          <ul className="space-y-2 text-sm">
            {items
              .filter((item) => item.reason !== null)
              .map((item) => (
                <li key={item.sessionId}>
                  {recoveryReasonMessage(item.reason!)}
                </li>
              ))}
          </ul>
        ) : null}

        <DialogFooter className="sm:justify-between">
          {state === "choice" ? (
            <>
              {discardTargetCount > 0 ? (
                <Button type="button" onClick={onIgnore}>
                  忽略
                </Button>
              ) : null}
              {restorableCount > 0 ? (
                <Button type="button" onClick={onRestore}>
                  恢复
                </Button>
              ) : null}
            </>
          ) : pending ? (
            <>
              <Button type="button" disabled>
                {state === "pending-ignore" ? "正在忽略…" : "忽略"}
              </Button>
              {state === "pending-restore" ? (
                <Button type="button" disabled>
                  正在恢复…
                </Button>
              ) : null}
            </>
          ) : state === "result" ? (
            <Button type="button" onClick={requestClose}>
              知道了
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
