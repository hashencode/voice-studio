import type { CSSProperties } from "react";
import { AudioLines, RadioTower, Settings2, Waves } from "lucide-react";

import { NavMain, type ShellNavigationItem } from "@/components/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
} from "@/components/ui/sidebar";
import type { RendererShellSection } from "@/features/shell/context-pane-contract";

const navigation: readonly ShellNavigationItem[] = [
  { section: "audio", title: "音频", icon: AudioLines },
  { section: "companion", title: "互联", icon: RadioTower },
  { section: "settings", title: "设置", icon: Settings2 },
];

export function AppSidebar({
  current,
  onNavigate,
}: {
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
}) {
  return (
    <Sidebar
      collapsible="none"
      role="navigation"
      aria-label="工作站主导航"
      style={{ "--sidebar-width": "4rem" } as CSSProperties}
    >
      <SidebarHeader>
        <div className="flex min-h-10 items-center justify-center">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Waves className="size-4" aria-hidden="true" />
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navigation} current={current} onNavigate={onNavigate} />
      </SidebarContent>
    </Sidebar>
  );
}
