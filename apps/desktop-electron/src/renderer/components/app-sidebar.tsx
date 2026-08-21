import type * as React from "react";
import { Cog, MonitorSmartphone, Music, Waves } from "lucide-react";

import { NavMain, type ShellNavigationItem } from "@/components/nav-main";
import { Sidebar, SidebarHeader } from "@/components/ui/sidebar";
import type {
  ContextPanePresentation,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";

const navigation: readonly ShellNavigationItem[] = [
  { section: "audio", title: SHELL_SECTION_LABELS.audio, icon: Music },
  {
    section: "companion",
    title: SHELL_SECTION_LABELS.companion,
    icon: MonitorSmartphone,
  },
  {
    section: "settings",
    title: SHELL_SECTION_LABELS.settings,
    icon: Cog,
  },
];

export function AppSidebar({
  current,
  onNavigate,
  presentation,
  activityCenter,
  children,
}: React.PropsWithChildren<{
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  presentation: ContextPanePresentation | "closed";
  activityCenter?: React.ReactNode;
}>) {
  return (
    <Sidebar
      collapsible="icon"
      mobileMode="inline"
      preserveCollapsedGap={presentation === "closed"}
      data-presentation={presentation}
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row data-[presentation=overlay]:z-20 data-[presentation=overlay]:!w-[min(var(--sidebar-width),100vw)]"
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
              aria-label="Voice2Text"
              className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
            >
              <Waves className="size-4" aria-hidden="true" />
            </span>
          </div>
        </SidebarHeader>
        <NavMain
          items={navigation}
          current={current}
          onNavigate={onNavigate}
          footerAction={activityCenter}
        />
      </Sidebar>
      {children}
    </Sidebar>
  );
}
