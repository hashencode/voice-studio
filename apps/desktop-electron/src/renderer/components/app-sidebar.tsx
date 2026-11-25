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
import type { RendererShellSection } from "@/features/shell/context-pane-contract";
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
  unreadActivityCount,
  navigationDisabled = false,
}: {
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
  unreadActivityCount: number;
  navigationDisabled?: boolean;
}) {
  return (
    <Sidebar
      collapsible="none"
      role="navigation"
      aria-label="工作站主导航"
      data-navigation-disabled={navigationDisabled ? "true" : undefined}
      inert={navigationDisabled}
      className="shrink-0 p-2"
    >
      <SidebarHeader className="h-[52px] shrink-0 items-center justify-center p-0">
        <span
          aria-label="Voice2Text"
          className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <Waves className="size-4" aria-hidden="true" />
        </span>
      </SidebarHeader>
      <NavMain
        items={navigation.map((item) =>
          item.section === "messages" && unreadActivityCount > 0
            ? {
                ...item,
                hasUnread: true,
                ariaLabel: "消息，有未读消息",
              }
            : item,
        )}
        current={current}
        disabled={navigationDisabled}
        onNavigate={onNavigate}
      />
      <SidebarFooter className="items-center p-2">
        <div
          aria-label="个人中心（即将推出）"
          data-shell-profile-placeholder="true"
          className="flex size-6 items-center justify-center"
        >
          <Avatar className="size-6" size="sm">
            <AvatarFallback>
              <UserRound className="size-3.5" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
