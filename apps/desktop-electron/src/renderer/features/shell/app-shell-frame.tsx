import type * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarRail,
} from "@/components/ui/sidebar";
import { ContextPaneShell } from "@/features/shell/context-pane-shell";
import {
  SHELL_GEOMETRY,
  SHELL_SECTION_LABELS,
  type RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { cn } from "@/lib/utils";

type AppShellFrameProps = React.PropsWithChildren<{
  section: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  unreadActivityCount: number;
  contextPane: React.ComponentProps<typeof ContextPaneShell> | null;
  onTogglePane: () => void;
  paneTriggerRef?: React.Ref<HTMLButtonElement>;
  title: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
  history: {
    canGoBack: boolean;
    canGoForward: boolean;
    onBack: () => void;
    onForward: () => void;
  };
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  contentRef?: React.Ref<HTMLDivElement>;
  contentPadding?: "none" | "compact" | "page";
  contentTone?: "default" | "muted";
}>;

// Independently composed from the pinned public render; controllers own all state.
// Electron keeps a docked pane at its 880px minimum instead of the preview's sheet.
export function AppShellFrame({
  section,
  onNavigate,
  unreadActivityCount,
  contextPane,
  onTogglePane,
  paneTriggerRef,
  title,
  titleRef,
  history,
  actions,
  notice,
  contentRef,
  contentPadding = "none",
  contentTone = "default",
  children,
}: AppShellFrameProps) {
  const open = contextPane?.open ?? false;
  const paneLabel = `${open ? "收起" : "打开"}${SHELL_SECTION_LABELS[contextPane?.section ?? section]}上下文面板`;

  return (
    <SidebarProvider
      open={open}
      persistState={false}
      enableKeyboardShortcut={false}
      className="relative h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": `${SHELL_GEOMETRY.expandedPrefixWidth}px`,
          "--sidebar-width-icon": `${SHELL_GEOMETRY.collapsedPrefixWidth}px`,
        } as React.CSSProperties
      }
    >
      <AppSidebar
        current={section}
        onNavigate={onNavigate}
        presentation={open && contextPane ? contextPane.presentation : "closed"}
        unreadActivityCount={unreadActivityCount}
      >
        {contextPane ? <ContextPaneShell {...contextPane} /> : null}
      </AppSidebar>
      {contextPane ? (
        <SidebarRail
          ref={paneTriggerRef}
          data-context-pane-midpoint-rail="true"
          type="button"
          aria-label={paneLabel}
          title={paneLabel}
          tabIndex={0}
          aria-expanded={open}
          onClick={onTogglePane}
          style={{
            left: open ? "var(--sidebar-width)" : "var(--sidebar-width-icon)",
          }}
          className="!top-1/2 right-auto !bottom-auto z-40 flex h-12 w-7 !translate-x-0 -translate-y-1/2 items-center justify-center rounded-md border bg-background text-muted-foreground after:hidden hover:bg-muted hover:text-foreground focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50"
        >
          {open ? (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          )}
        </SidebarRail>
      ) : null}
      <SidebarInset className="z-30 min-h-0 min-w-0 overflow-hidden">
        <header
          data-shell-slot="content-head"
          className="sticky top-0 z-10 flex h-[50px] shrink-0 items-center gap-1.5 border-b bg-background px-4"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="后退"
            disabled={!history.canGoBack}
            onClick={history.onBack}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="前进"
            disabled={!history.canGoForward}
            onClick={history.onForward}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="min-w-0 flex-1 truncate text-sm leading-snug font-semibold"
            data-slot="content-title"
          >
            {title}
          </h1>
          {actions ? (
            <div data-shell-slot="page-actions" className="ml-auto shrink-0">
              {actions}
            </div>
          ) : null}
        </header>
        {notice ? (
          <div data-shell-slot="content-notice" className="shrink-0">
            {notice}
          </div>
        ) : null}
        <div
          ref={contentRef}
          id="main-content"
          data-shell-slot="content"
          data-context-pane-background="true"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto",
            contentPadding === "compact" && "p-4",
            contentPadding === "page" && "p-4 sm:p-6",
            contentTone === "muted" && "bg-muted/20",
          )}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
