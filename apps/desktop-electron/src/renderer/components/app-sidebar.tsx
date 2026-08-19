import type * as React from "react";
import { AudioLines, RadioTower, Settings2, Waves } from "lucide-react";

import { NavMain, type ShellNavigationItem } from "@/components/nav-main";
import { Sidebar, SidebarHeader } from "@/components/ui/sidebar";
import type {
  ContextPaneCloseReason,
  ContextPanePresentation,
  ContextPaneSection,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { ContextPaneShell } from "@/features/shell/context-pane-shell";

const navigation: readonly ShellNavigationItem[] = [
  { section: "audio", title: "音频", icon: AudioLines },
  { section: "companion", title: "互联", icon: RadioTower },
  { section: "settings", title: "设置", icon: Settings2 },
];

export function AppSidebar({
  current,
  onNavigate,
  paneSection,
  paneOpen,
  panePresentation,
  paneTriggerRef,
  onRequestPaneClose,
  children,
}: React.PropsWithChildren<{
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  paneSection: ContextPaneSection | null;
  paneOpen: boolean;
  panePresentation: ContextPanePresentation;
  paneTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onRequestPaneClose: (reason: ContextPaneCloseReason) => void;
}>) {
  const shellPresentation = paneOpen ? panePresentation : "closed";

  return (
    <Sidebar
      collapsible="icon"
      data-presentation={shellPresentation}
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row data-[presentation=overlay]:z-20 data-[presentation=overlay]:!w-(--sidebar-width)"
    >
      <Sidebar
        collapsible="none"
        role="navigation"
        aria-label="工作站主导航"
        className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r"
      >
        <SidebarHeader>
          <div className="flex min-h-8 items-center justify-center">
            <span
              data-testid="application-mark"
              aria-label="Voice2Text"
              className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
            >
              <Waves className="size-4" aria-hidden="true" />
            </span>
          </div>
        </SidebarHeader>
        <NavMain items={navigation} current={current} onNavigate={onNavigate} />
      </Sidebar>
      {paneSection && paneOpen ? (
        <ContextPaneShell
          section={paneSection}
          presentation={panePresentation}
          triggerRef={paneTriggerRef}
          onRequestClose={onRequestPaneClose}
        >
          {children}
        </ContextPaneShell>
      ) : null}
    </Sidebar>
  );
}
