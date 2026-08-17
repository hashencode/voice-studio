import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ContextPaneCloseReason,
  ContextPanePresentation,
  ContextPaneSection,
} from "@/features/shell/context-pane-contract";
import { cn } from "@/lib/utils";

export function ContextPaneShell({
  section,
  presentation,
  triggerRef,
  onRequestClose,
  children,
}: React.PropsWithChildren<{
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onRequestClose: (reason: ContextPaneCloseReason) => void;
}>) {
  const label = section === "audio" ? "音频" : "互联";

  const close = React.useCallback(
    (reason: ContextPaneCloseReason) => {
      onRequestClose(reason);
      triggerRef.current?.focus();
    },
    [onRequestClose, triggerRef],
  );

  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close("escape");
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [close]);

  return (
    <aside
      role="complementary"
      aria-label={`${label}上下文面板`}
      data-presentation={presentation}
      className={cn(
        "flex h-svh w-72 shrink-0 flex-col border-r bg-card",
        presentation === "overlay" && "fixed inset-y-0 left-16 z-20 shadow-xl",
      )}
    >
      <div className="flex min-h-16 items-center justify-between gap-3 border-b px-4">
        <h2 className="font-semibold">{label}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`关闭${label}上下文面板`}
          onClick={() => close("close-button")}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </aside>
  );
}

export function ContextPanePlaceholder({
  section,
}: {
  section: ContextPaneSection;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        {section === "audio" ? "音频列表" : "已信任设备"}
      </p>
      <p className="text-muted-foreground">
        {section === "audio"
          ? "音频列表与处理状态将在此显示。"
          : "设备列表与配对入口将在此显示。"}
      </p>
    </div>
  );
}
