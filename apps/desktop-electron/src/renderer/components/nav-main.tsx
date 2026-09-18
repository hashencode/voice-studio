import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { RendererShellSection } from "@/features/shell/context-pane-contract";

export interface ShellNavigationItem {
  section: RendererShellSection;
  title: string;
  icon: LucideIcon;
  placement?: "primary" | "footer";
  hasUnread?: boolean;
  ariaLabel?: string;
}

export function NavMain({
  items,
  current,
  disabled = false,
  onNavigate,
}: {
  items: readonly ShellNavigationItem[];
  current: RendererShellSection;
  disabled?: boolean;
  onNavigate: (section: RendererShellSection) => void;
}) {
  const primaryItems = items.filter((item) => item.placement !== "footer");
  const footerItems = items.filter((item) => item.placement === "footer");

  const renderItem = (item: ShellNavigationItem) => {
    return (
      <SidebarMenuItem key={item.section}>
        <SidebarMenuButton
          type="button"
          tooltip={{ children: item.title, hidden: false }}
          isActive={current === item.section}
          aria-current={current === item.section ? "page" : undefined}
          aria-label={item.ariaLabel ?? item.title}
          disabled={disabled}
          className="px-2.5 md:px-2"
          onClick={() => onNavigate(item.section)}
        >
          <item.icon aria-hidden="true" />
          {item.hasUnread ? (
            <Badge
              variant="dot-destructive"
              aria-hidden="true"
              className="absolute top-0 right-0"
            />
          ) : null}
          <span className="sr-only">{item.title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <>
      <SidebarContent>
        <SidebarGroup className="pt-2.5">
          <SidebarGroupLabel className="sr-only">工作台</SidebarGroupLabel>
          <SidebarGroupContent className="px-1.5 md:px-0">
            <SidebarMenu className="gap-0.5">
              {primaryItems.map(renderItem)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {footerItems.length > 0 ? (
        <SidebarFooter>
          {footerItems.map((item) => (
            <SidebarMenu key={item.section}>{renderItem(item)}</SidebarMenu>
          ))}
        </SidebarFooter>
      ) : null}
    </>
  );
}
