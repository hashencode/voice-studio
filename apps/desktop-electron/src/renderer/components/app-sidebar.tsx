import {
  ClipboardList,
  Library,
  RadioTower,
  Settings2,
  Waves,
} from "lucide-react";

import { NavMain, type ShellNavigationItem } from "@/components/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { ShellSection } from "@shared/contracts";

const navigation: readonly ShellNavigationItem[] = [
  { section: "library", title: "会议库", icon: Library },
  { section: "tasks", title: "转写任务", icon: ClipboardList },
  { section: "companion", title: "Companion", icon: RadioTower },
  { section: "settings", title: "设置", icon: Settings2 },
];

export function AppSidebar({
  current,
  onNavigate,
}: {
  current: ShellSection;
  onNavigate: (section: ShellSection) => void;
}) {
  return (
    <Sidebar collapsible="icon" role="navigation" aria-label="工作站主导航">
      <SidebarHeader>
        <div className="flex min-h-10 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Waves className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-semibold">
              Voice2Text
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              本机工作区
            </span>
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navigation} current={current} onNavigate={onNavigate} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:sr-only">
              Electron 独立资料库
            </p>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail aria-label="切换侧边栏" title="切换侧边栏" />
    </Sidebar>
  );
}
