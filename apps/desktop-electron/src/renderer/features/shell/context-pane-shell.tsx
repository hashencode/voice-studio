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
  head,
  search,
  searchOpen = true,
  filters,
  footer,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  onRequestClose: () => void;
  head?: React.ReactNode;
  search?: React.ReactNode;
  searchOpen?: boolean;
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
      className="w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-2px)]! shrink-0 bg-background text-foreground"
    >
      <SidebarHeader
        data-shell-slot="context-head"
        data-context-pane-head="true"
        data-context-pane-fixed-header="true"
        className={cn(
          "shrink-0 gap-0 p-0",
          section === "audio" ? "h-[42px]" : "h-[50px]",
          section !== "audio" && "border-b",
        )}
      >
        <div className="flex h-full min-w-0 shrink-0 items-center justify-between gap-(--spacing-context-compact) px-(--spacing-context-inline)">
          <h2 className="truncate text-sm font-semibold">{label}</h2>
          {head ? <div className="min-w-0 shrink-0">{head}</div> : null}
        </div>
      </SidebarHeader>
      {search ? (
        <ContextPaneSearchRegion
          open={searchOpen}
          compact={section === "audio"}
        >
          {search}
        </ContextPaneSearchRegion>
      ) : null}
      {filters ? (
        <div
          data-shell-slot="context-filters"
          data-context-pane-filters="true"
          className="flex h-[37px] shrink-0 items-center border-b border-border/60 px-(--spacing-context-compact) py-1.5"
        >
          {filters}
        </div>
      ) : null}
      <SidebarContent
        data-shell-slot="context-list"
        data-context-pane-scrolling-content="true"
        className="gap-0"
      >
        {children}
      </SidebarContent>
      {footer ? (
        <SidebarFooter
          data-shell-slot="context-footer"
          data-context-pane-fixed-footer="true"
          className="shrink-0 border-t p-(--spacing-context-compact)"
        >
          {footer}
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}

export function ContextPaneSearchRegion({
  open,
  compact = false,
  children,
}: React.PropsWithChildren<{ open: boolean; compact?: boolean }>) {
  return (
    <div
      data-shell-slot="context-search"
      data-context-pane-search="true"
      data-state={open ? "open" : "closed"}
      aria-hidden={!open}
      inert={open ? undefined : true}
      className="grid shrink-0 grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none data-[state=closed]:grid-rows-[0fr] data-[state=closed]:opacity-0"
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex items-center border-b border-border/60",
            compact
              ? "px-(--spacing-context-compact) pt-(--spacing-context-tight) pb-(--spacing-context-compact)"
              : "h-[45px] px-(--spacing-context-inline) py-1.5",
          )}
        >
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
