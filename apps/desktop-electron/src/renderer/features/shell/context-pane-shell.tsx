import * as React from "react";
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
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";

export function ContextPaneShell({
  section,
  presentation,
  onRequestClose,
  header,
  children,
}: React.PropsWithChildren<{
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  onRequestClose: (reason: ContextPaneCloseReason) => void;
  header?: React.ReactNode;
}>) {
  const label = SHELL_SECTION_LABELS[section];

  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onRequestClose("escape");
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onRequestClose]);

  return (
    <Sidebar
      collapsible="none"
      role="complementary"
      aria-label={`${label}上下文面板`}
      data-presentation={presentation}
      className="min-w-0 flex-1"
    >
      <SidebarHeader
        data-context-pane-fixed-header="true"
        className="shrink-0 gap-2 border-b p-2"
      >
        <div className="flex min-h-10 items-center px-2">
          <h2 className="font-semibold">{label}</h2>
        </div>
        {header}
      </SidebarHeader>
      <SidebarContent data-context-pane-scrolling-content="true">
        {children}
      </SidebarContent>
    </Sidebar>
  );
}
