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

export type RecoveryDialogState =
  | "assessing"
  | "choice"
  | "pending-delete"
  | "pending-restore"
  | "retry-delete"
  | "retry-restore"
  | "hidden";

export function RecoveryDialog({
  state,
  items,
  onRestore,
  onDelete,
  onRequestFocusFallback,
}: {
  state: RecoveryDialogState;
  items: CaptureRecoveryItem[];
  onRestore: () => void;
  onDelete: () => void;
  onRequestFocusFallback: () => void;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const open = state !== "assessing" && state !== "hidden";
  const pending = state === "pending-restore" || state === "pending-delete";
  const retryingDelete = state === "retry-delete";
  const retryingRestore = state === "retry-restore";

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRequestFocusFallback();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>发现可恢复的录音</DialogTitle>
          <DialogDescription>
            发现 {items.length} 段可恢复录音。下方操作会处理本批全部录音。
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <p className="border-y bg-muted/40 py-3 text-sm font-medium">
            {state === "pending-restore" ? "正在恢复…" : "正在删除…"}
          </p>
        ) : null}

        {retryingDelete || retryingRestore ? (
          <p className="border-y border-destructive/40 bg-destructive/5 py-3 text-sm">
            数据状态尚未确认，请再次执行原操作。
          </p>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="destructive"
            disabled={pending || retryingRestore}
            onClick={onDelete}
          >
            {state === "pending-delete" ? "正在删除…" : "删除数据"}
          </Button>
          <Button
            type="button"
            disabled={pending || retryingDelete}
            onClick={onRestore}
          >
            {state === "pending-restore" ? "正在恢复…" : "立即恢复"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
