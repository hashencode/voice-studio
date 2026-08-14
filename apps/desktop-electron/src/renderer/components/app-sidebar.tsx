"use client";

import * as React from "react";
import {
  AudioLines,
  CircleUserRound,
  ClipboardList,
  FolderClock,
  GalleryVerticalEnd,
  Library,
  RadioTower,
  Settings2,
} from "lucide-react";

import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

const data = {
  user: {
    name: "本机用户",
    email: "仅本地数据",
    avatar: "",
  },
  teams: [
    {
      name: "Voice2Text",
      logo: GalleryVerticalEnd,
      plan: "Local workspace",
    },
  ],
  navMain: [
    {
      title: "会议库",
      url: "#",
      icon: Library,
      isActive: true,
      items: [
        {
          title: "最近会议",
          url: "#",
        },
        {
          title: "已收藏",
          url: "#",
        },
      ],
    },
    {
      title: "转写任务",
      url: "#",
      icon: ClipboardList,
      items: [
        {
          title: "运行中",
          url: "#",
        },
        {
          title: "可恢复",
          url: "#",
        },
        {
          title: "已完成",
          url: "#",
        },
      ],
    },
    {
      title: "Companion",
      url: "#",
      icon: RadioTower,
      items: [
        {
          title: "接收器",
          url: "#",
        },
        {
          title: "传输记录",
          url: "#",
        },
      ],
    },
    {
      title: "Settings",
      url: "#",
      icon: Settings2,
      items: [
        {
          title: "通用",
          url: "#",
        },
        {
          title: "模型与运行时",
          url: "#",
        },
        {
          title: "隐私与网络",
          url: "#",
        },
      ],
    },
  ],
  projects: [
    {
      name: "录制与恢复",
      url: "#",
      icon: AudioLines,
    },
    {
      name: "处理工作区",
      url: "#",
      icon: FolderClock,
    },
    {
      name: "本机身份",
      url: "#",
      icon: CircleUserRound,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavProjects projects={data.projects} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
