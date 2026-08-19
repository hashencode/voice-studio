import * as React from "react";
import type { LucideIcon } from "lucide-react";

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
}

export function NavMain({
  items,
  current,
  onNavigate,
}: {
  items: readonly ShellNavigationItem[];
  current: RendererShellSection;
  onNavigate: (section: RendererShellSection) => void;
}) {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [rovingSection, setRovingSection] =
    React.useState<RendererShellSection | null>(null);
  const rovingIndex = Math.max(
    0,
    items.findIndex((item) => item.section === (rovingSection ?? current)),
  );
  const primaryItems = items.filter((item) => item.section !== "settings");
  const settingsItem = items.find((item) => item.section === "settings");

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
    const targetItem = items[target];
    if (!targetItem) return;
    setRovingSection(targetItem.section);
    buttons.current[target]?.focus();
  };

  const renderItem = (item: ShellNavigationItem) => {
    const index = items.indexOf(item);
    return (
      <SidebarMenuItem key={item.section}>
        <SidebarMenuButton
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          tooltip={{ children: item.title, hidden: false }}
          isActive={current === item.section}
          tabIndex={rovingIndex === index ? 0 : -1}
          aria-current={current === item.section ? "page" : undefined}
          aria-label={item.title}
          className="mx-auto size-10 justify-center p-0"
          onClick={() => {
            setRovingSection(item.section);
            onNavigate(item.section);
          }}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <item.icon aria-hidden="true" />
          <span className="sr-only">{item.title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="sr-only">工作台</SidebarGroupLabel>
          <SidebarGroupContent className="px-1.5 md:px-0">
            <SidebarMenu>{primaryItems.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {settingsItem ? (
        <SidebarFooter>
          <SidebarMenu>{renderItem(settingsItem)}</SidebarMenu>
        </SidebarFooter>
      ) : null}
    </>
  );
}
