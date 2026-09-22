import * as React from "react";

import { cn } from "@/lib/utils";

const KEYBOARD_STEP = 10;

type ActiveResize = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  previousBodyCursor: string;
  previousBodyUserSelect: string;
};

type PaneResizeHandleProps = Omit<
  React.ComponentProps<"div">,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
> & {
  value: number;
  minimum: number;
  maximum: number;
  disabled?: boolean;
  cancellationKey: React.Key;
  onResize: (width: number) => void;
  onResizeStateChange?: (resizing: boolean) => void;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function PaneResizeHandle({
  value,
  minimum,
  maximum,
  disabled = false,
  cancellationKey,
  onResize,
  onResizeStateChange,
  className,
  onKeyDown,
  ...props
}: PaneResizeHandleProps) {
  const handleRef = React.useRef<HTMLDivElement>(null);
  const activeResizeRef = React.useRef<ActiveResize | null>(null);
  const pendingWidthRef = React.useRef<number | null>(null);
  const animationFrameRef = React.useRef<number | null>(null);
  const onResizeRef = React.useRef(onResize);
  const onResizeStateChangeRef = React.useRef(onResizeStateChange);
  const finishResizeRef = React.useRef<(commitPending: boolean) => void>(
    () => undefined,
  );
  const [resizing, setResizing] = React.useState(false);

  React.useLayoutEffect(() => {
    onResizeRef.current = onResize;
    onResizeStateChangeRef.current = onResizeStateChange;
  }, [onResize, onResizeStateChange]);

  const cancelPendingFrame = React.useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const applyPendingWidth = React.useCallback(() => {
    cancelPendingFrame();
    const pendingWidth = pendingWidthRef.current;
    pendingWidthRef.current = null;
    if (pendingWidth !== null) onResizeRef.current(pendingWidth);
  }, [cancelPendingFrame]);

  const cancelActiveResize = React.useCallback(() => {
    finishResizeRef.current(false);
  }, []);

  const finishResize = React.useCallback(
    (commitPending: boolean) => {
      const activeResize = activeResizeRef.current;
      if (!activeResize) return;

      if (commitPending) applyPendingWidth();
      else {
        cancelPendingFrame();
        pendingWidthRef.current = null;
      }

      activeResizeRef.current = null;
      window.removeEventListener("blur", cancelActiveResize);
      document.body.style.cursor = activeResize.previousBodyCursor;
      document.body.style.userSelect = activeResize.previousBodyUserSelect;
      setResizing(false);
      onResizeStateChangeRef.current?.(false);

      const handle = handleRef.current;
      if (handle?.hasPointerCapture(activeResize.pointerId)) {
        handle.releasePointerCapture(activeResize.pointerId);
      }
    },
    [applyPendingWidth, cancelActiveResize, cancelPendingFrame],
  );

  React.useLayoutEffect(() => {
    finishResizeRef.current = finishResize;
  }, [finishResize]);

  React.useLayoutEffect(
    () => cancelActiveResize,
    [cancelActiveResize, cancellationKey, disabled],
  );

  const queueResize = React.useCallback(
    (width: number) => {
      pendingWidthRef.current = clamp(width, minimum, maximum);
      if (animationFrameRef.current !== null) return;
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        const pendingWidth = pendingWidthRef.current;
        pendingWidthRef.current = null;
        if (pendingWidth !== null && activeResizeRef.current) {
          onResizeRef.current(pendingWidth);
        }
      });
    },
    [maximum, minimum],
  );

  return (
    <div
      ref={handleRef}
      {...props}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-slot="pane-resize-handle"
      data-resizing={resizing ? "true" : "false"}
      className={cn(
        "group/pane-resize pointer-events-none absolute inset-y-0 z-40 w-2 -translate-x-1/2 outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-border focus-visible:after:bg-ring",
        "aria-disabled:opacity-50",
        className,
      )}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || disabled) return;
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          const nextWidth = event.key === "Home" ? minimum : maximum;
          if (nextWidth !== value) onResizeRef.current(nextWidth);
          return;
        }
        const direction =
          event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const nextWidth = clamp(
          value + direction * KEYBOARD_STEP,
          minimum,
          maximum,
        );
        if (nextWidth !== value) onResizeRef.current(nextWidth);
      }}
      onPointerDown={(event) => {
        if (
          disabled ||
          activeResizeRef.current ||
          !event.isPrimary ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        activeResizeRef.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startWidth: clamp(value, minimum, maximum),
          previousBodyCursor: document.body.style.cursor,
          previousBodyUserSelect: document.body.style.userSelect,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("blur", cancelActiveResize);
        setResizing(true);
        onResizeStateChangeRef.current?.(true);
      }}
      onPointerMove={(event) => {
        const activeResize = activeResizeRef.current;
        if (!activeResize || event.pointerId !== activeResize.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        queueResize(
          activeResize.startWidth + event.clientX - activeResize.startClientX,
        );
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== activeResizeRef.current?.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        finishResize(true);
      }}
      onPointerCancel={(event) => {
        if (event.pointerId !== activeResizeRef.current?.pointerId) return;
        finishResize(false);
      }}
      onLostPointerCapture={cancelActiveResize}
    >
      <span
        aria-hidden="true"
        data-pane-resize-hit-area="upper"
        className={cn(
          "absolute inset-x-0 top-0 bottom-[calc(50%+1.5rem)] touch-none",
          disabled
            ? "pointer-events-none"
            : "pointer-events-auto cursor-col-resize",
        )}
      />
      <span
        aria-hidden="true"
        data-pane-resize-hit-area="lower"
        className={cn(
          "absolute inset-x-0 top-[calc(50%+1.5rem)] bottom-0 touch-none",
          disabled
            ? "pointer-events-none"
            : "pointer-events-auto cursor-col-resize",
        )}
      />
    </div>
  );
}

export { PaneResizeHandle };
