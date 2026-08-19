import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
} from "@/components/ui/sidebar";
import type {
  ContextPaneCloseReason,
  ContextPanePresentation,
  ContextPaneSection,
} from "@/features/shell/context-pane-contract";

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
    <Sidebar
      collapsible="none"
      role="complementary"
      aria-label={`${label}上下文面板`}
      data-presentation={presentation}
      className="min-w-0 flex-1"
    >
      <SidebarHeader className="flex min-h-16 flex-row items-center justify-between gap-3 border-b px-4">
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
      </SidebarHeader>
      <SidebarContent className="p-4">{children}</SidebarContent>
    </Sidebar>
  );
}
