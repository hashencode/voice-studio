import * as React from "react";
import type { LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { ShellSection } from "@shared/contracts";

export interface ShellNavigationItem {
  section: ShellSection;
  title: string;
  icon: LucideIcon;
}

export function NavMain({
  items,
  current,
  onNavigate,
}: {
  items: readonly ShellNavigationItem[];
  current: ShellSection;
  onNavigate: (section: ShellSection) => void;
}) {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let target = index;
    if (event.key === "ArrowDown") target = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      target = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = items.length - 1;
    else return;
    event.preventDefault();
    buttons.current[target]?.focus();
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>工作台</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item, index) => (
          <SidebarMenuItem key={item.section}>
            <SidebarMenuButton
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              tooltip={item.title}
              isActive={current === item.section}
              aria-current={current === item.section ? "page" : undefined}
              onClick={() => onNavigate(item.section)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <item.icon aria-hidden="true" />
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
