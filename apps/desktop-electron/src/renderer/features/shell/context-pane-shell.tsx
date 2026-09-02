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
import { cn } from "@/lib/utils";

export function ContextPaneShell({
  open,
  section,
  presentation,
  onRequestClose,
  variant = "default",
  head,
  search,
  filters,
  footer,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  onRequestClose: () => void;
  variant?: "default" | "audio";
  head?: React.ReactNode;
  search?: React.ReactNode;
  filters?: React.ReactNode;
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
      className={cn(
        "w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]! shrink-0",
        variant === "audio" && "bg-background text-foreground",
      )}
    >
      <SidebarHeader
        data-context-pane-head="true"
        data-context-pane-fixed-header="true"
        className="h-[50px] shrink-0 gap-0 border-b p-0"
      >
        <div className="flex h-full min-w-0 shrink-0 items-center justify-between gap-2 px-3">
          <h2 className="truncate text-sm font-semibold">{label}</h2>
          {head ? <div className="min-w-0 shrink-0">{head}</div> : null}
        </div>
      </SidebarHeader>
      {search ? (
        <div
          data-context-pane-search="true"
          className="flex h-[45px] shrink-0 items-center border-b px-3 py-2"
        >
          <div className="min-w-0 flex-1">{search}</div>
        </div>
      ) : null}
      {filters ? (
        <div
          data-context-pane-filters="true"
          className="flex h-[35px] shrink-0 items-center border-b px-3 py-1.5"
        >
          {filters}
        </div>
      ) : null}
      <SidebarContent
        data-context-pane-scrolling-content="true"
        className="gap-0"
      >
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
