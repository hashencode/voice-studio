import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { PaneResizeHandle } from "@/components/ui/pane-resize-handle";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarRail,
} from "@/components/ui/sidebar";
import { ContextPaneShell } from "@/features/shell/context-pane-shell";
import {
  expandedContextPanePrefixWidth,
  SHELL_GEOMETRY,
  SHELL_SECTION_LABELS,
  type RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { cn } from "@/lib/utils";

type ContextPaneResizeConfig = {
  minimum: number;
  maximum: number;
  disabled?: boolean;
  onChange: (width: number) => void;
};

type AppShellFrameProps = React.PropsWithChildren<{
  section: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  unreadActivityCount: number;
  contextPane: React.ComponentProps<typeof ContextPaneShell> | null;
  contextPaneWidth: number;
  contextPaneResize?: ContextPaneResizeConfig;
  onTogglePane: () => void;
  paneTriggerRef?: React.Ref<HTMLButtonElement>;
  title: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
  customTitle?: React.ReactNode;
  showHeader?: boolean;
  visibility?: {
    navigation: boolean;
  };
  navigationDisabled?: boolean;
  backAction?: {
    label: string;
    onBack: () => void;
  };
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  contentRef?: React.Ref<HTMLDivElement>;
  contentPadding?: "none" | "compact" | "page";
  contentTone?: "default" | "muted";
  footer?: React.ReactNode;
}>;

// Independently composed from the pinned public render; controllers own all state.
// Electron keeps a docked pane at its 880px minimum instead of the preview's sheet.
export function AppShellFrame({
  section,
  onNavigate,
  unreadActivityCount,
  contextPane,
  contextPaneWidth,
  contextPaneResize,
  onTogglePane,
  paneTriggerRef,
  title,
  titleRef,
  customTitle,
  showHeader = true,
  visibility,
  navigationDisabled = false,
  backAction,
  actions,
  notice,
  contentRef,
  contentPadding = "none",
  contentTone = "default",
  footer,
  children,
}: AppShellFrameProps) {
  const [contextPaneResizing, setContextPaneResizing] = React.useState(false);
  const open = contextPane?.open ?? false;
  const navigationVisible = visibility?.navigation ?? true;
  const paneLabel = `${open ? "收起" : "打开"}${SHELL_SECTION_LABELS[contextPane?.section ?? section]}上下文面板`;
  const resizeLabel = `调整${SHELL_SECTION_LABELS[contextPane?.section ?? section]}上下文面板宽度`;

  return (
    <SidebarProvider
      open={open}
      persistState={false}
      enableKeyboardShortcut={false}
      data-resizing={contextPaneResizing ? "true" : undefined}
      className="relative h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": `${expandedContextPanePrefixWidth(contextPaneWidth)}px`,
          "--sidebar-width-icon": `${SHELL_GEOMETRY.collapsedPrefixWidth}px`,
        } as React.CSSProperties
      }
    >
      {navigationVisible ? (
        <AppSidebar
          current={section}
          onNavigate={onNavigate}
          navigationDisabled={navigationDisabled}
          presentation={
            open && contextPane ? contextPane.presentation : "closed"
          }
          unreadActivityCount={unreadActivityCount}
        >
          {contextPane ? <ContextPaneShell {...contextPane} /> : null}
        </AppSidebar>
      ) : null}
      {navigationVisible && contextPane && open && contextPaneResize ? (
        <PaneResizeHandle
          aria-label={resizeLabel}
          value={contextPaneWidth}
          minimum={contextPaneResize.minimum}
          maximum={contextPaneResize.maximum}
          disabled={contextPaneResize.disabled}
          cancellationKey={section}
          onResize={contextPaneResize.onChange}
          onResizeStateChange={setContextPaneResizing}
          style={{ left: "var(--sidebar-width)" }}
        />
      ) : null}
      {navigationVisible && contextPane ? (
        <SidebarRail
          ref={paneTriggerRef}
          variant="handle"
          data-context-pane-midpoint-rail="true"
          type="button"
          aria-label={paneLabel}
          title={paneLabel}
          tabIndex={0}
          aria-expanded={open}
          disabled={navigationDisabled}
          onClick={onTogglePane}
          style={{
            left: open ? "var(--sidebar-width)" : "var(--sidebar-width-icon)",
          }}
        />
      ) : null}
      <SidebarInset className="z-30 min-h-0 min-w-0 overflow-hidden">
        {showHeader ? (
          <header
            data-shell-slot="content-head"
            className="flex h-[50px] shrink-0 items-center gap-1.5 border-b bg-background px-(--spacing-shell-header-inline)"
          >
            {backAction ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={backAction.label}
                  onClick={backAction.onBack}
                >
                  <ArrowLeft aria-hidden="true" />
                </Button>
                <Separator
                  orientation="vertical"
                  className="mx-2 data-[orientation=vertical]:h-5"
                />
              </>
            ) : null}
            {customTitle !== undefined ? (
              <div data-shell-slot="custom-title" className="min-w-0 flex-1">
                {customTitle}
              </div>
            ) : (
              <h1
                ref={titleRef}
                tabIndex={-1}
                className="min-w-0 flex-1 truncate text-sm leading-snug font-semibold"
                data-slot="content-title"
              >
                {title}
              </h1>
            )}
            {actions ? (
              <div data-shell-slot="page-actions" className="ml-auto shrink-0">
                {actions}
              </div>
            ) : null}
          </header>
        ) : null}
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
            contentPadding === "compact" && "p-(--spacing-shell-compact)",
            contentPadding === "page" &&
              "p-(--spacing-shell-page) sm:p-(--spacing-shell-page-wide)",
            contentTone === "muted" && "bg-muted/20",
          )}
        >
          {children}
        </div>
        {footer ? (
          <footer
            data-shell-slot="content-footer"
            className="flex w-full shrink-0 flex-nowrap items-center border-t bg-background"
          >
            {footer}
          </footer>
        ) : null}
      </SidebarInset>
    </SidebarProvider>
  );
}
