import * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import type {
  ContextPanePresentation,
  ContextPaneSection,
} from "@/features/shell/context-pane-contract";
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";

export function ContextPaneShell({
  open,
  section,
  presentation,
  onRequestClose,
  collapseControl,
  header,
  footer,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  onRequestClose: () => void;
  collapseControl?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}>) {
  const label = SHELL_SECTION_LABELS[section];

  React.useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onRequestClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onRequestClose, open]);

  return (
    <Sidebar
      collapsible="none"
      role="complementary"
      aria-label={`${label}上下文面板`}
      aria-hidden={!open}
      inert={!open}
      data-presentation={presentation}
      className="w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]! shrink-0"
    >
      <SidebarHeader
        data-context-pane-fixed-header="true"
        className="min-h-[58px] shrink-0 gap-2 border-b p-2"
      >
        <div className="flex min-h-[42px] min-w-0 items-center justify-between gap-2 px-2">
          <h2 className="font-semibold">{label}</h2>
          {collapseControl}
        </div>
        {header}
      </SidebarHeader>
      <SidebarContent data-context-pane-scrolling-content="true">
        {children}
      </SidebarContent>
      {footer ? (
        <SidebarFooter
          data-context-pane-fixed-footer="true"
          className="shrink-0 border-t p-2"
        >
          {footer}
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}
