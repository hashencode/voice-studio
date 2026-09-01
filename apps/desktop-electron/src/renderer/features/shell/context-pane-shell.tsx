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
  collapseControl,
  primaryHeader,
  header,
  footer,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  section: ContextPaneSection;
  presentation: ContextPanePresentation;
  onRequestClose: () => void;
  variant?: "default" | "audio";
  collapseControl?: React.ReactNode;
  primaryHeader?: React.ReactNode;
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
      className={cn(
        "w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]! shrink-0",
        variant === "audio" && "bg-background text-foreground",
      )}
    >
      <SidebarHeader
        data-context-pane-fixed-header="true"
        className={cn(
          "shrink-0 gap-2 border-b p-2",
          variant === "audio"
            ? header
              ? "min-h-12"
              : "h-12"
            : header
              ? "min-h-[58px]"
              : "h-[58px]",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 shrink-0 items-center justify-between gap-2 px-2",
            variant === "audio" ? "h-8" : "h-[42px]",
          )}
        >
          <h2 className={cn("font-semibold", primaryHeader && "sr-only")}>
            {label}
          </h2>
          {primaryHeader ? (
            <div className="min-w-0 flex-1">{primaryHeader}</div>
          ) : null}
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
