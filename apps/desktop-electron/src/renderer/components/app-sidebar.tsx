import type * as React from "react";
import {
  AudioLines,
  Bell,
  Cog,
  SendHorizontal,
  UserRound,
  Waves,
} from "lucide-react";

import { NavMain, type ShellNavigationItem } from "@/components/nav-main";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sidebar, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import type {
  ContextPanePresentation,
  RendererShellSection,
} from "@/features/shell/context-pane-contract";
import { SHELL_SECTION_LABELS } from "@/features/shell/context-pane-contract";

const navigation: readonly ShellNavigationItem[] = [
  { section: "audio", title: SHELL_SECTION_LABELS.audio, icon: AudioLines },
  {
    section: "companion",
    title: SHELL_SECTION_LABELS.companion,
    icon: SendHorizontal,
  },
  {
    section: "messages",
    title: SHELL_SECTION_LABELS.messages,
    icon: Bell,
    placement: "footer",
  },
  {
    section: "settings",
    title: SHELL_SECTION_LABELS.settings,
    icon: Cog,
    placement: "footer",
  },
];

export function AppSidebar({
  current,
  onNavigate,
  presentation,
  unreadActivityCount,
  children,
}: React.PropsWithChildren<{
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  presentation: ContextPanePresentation | "closed";
  unreadActivityCount: number;
}>) {
  return (
    <Sidebar
      collapsible="icon"
      mobileMode="inline"
      data-presentation={presentation}
      className="z-20 overflow-hidden *:data-[sidebar=sidebar]:flex-row data-[presentation=overlay]:!w-[min(var(--sidebar-width),100vw)]"
    >
      <Sidebar
        collapsible="none"
        role="navigation"
        aria-label="工作站主导航"
        className="w-[calc(var(--sidebar-width-icon)+1px)]! shrink-0 border-r"
      >
        <SidebarHeader className="h-[50px] shrink-0">
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
          items={navigation.map((item) =>
            item.section === "messages" && unreadActivityCount > 0
              ? {
                  ...item,
                  badgeCount: unreadActivityCount,
                  ariaLabel: `消息，${unreadActivityCount} 条未读`,
                }
              : item,
          )}
          current={current}
          onNavigate={onNavigate}
        />
        <SidebarFooter className="items-center px-2 pt-0 pb-3">
          <div
            aria-label="个人中心（即将推出）"
            data-shell-profile-placeholder="true"
            className="flex size-7 items-center justify-center"
          >
            <Avatar className="size-7" size="sm">
              <AvatarFallback>
                <UserRound className="size-3.5" aria-hidden="true" />
              </AvatarFallback>
            </Avatar>
          </div>
        </SidebarFooter>
      </Sidebar>
      {children}
    </Sidebar>
  );
}
