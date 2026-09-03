// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoxesIcon } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NavProjects } from "@/components/nav-projects";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApplicationBlocker } from "@/components/application-blocker";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ModalCoordinatorProvider,
  useModalCoordinator,
} from "@/components/ui/modal-coordinator";
import componentConfig from "../../../components.json";

afterEach(() => {
  vi.restoreAllMocks();
});

function ControlledSidebar({
  onOpenChange,
  persistState = true,
  enableKeyboardShortcut = true,
}: {
  onOpenChange: (open: boolean) => void;
  persistState?: boolean;
  enableKeyboardShortcut?: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange(nextOpen);
      }}
      persistState={persistState}
      enableKeyboardShortcut={enableKeyboardShortcut}
    >
      <SidebarTrigger aria-label="切换侧栏" />
    </SidebarProvider>
  );
}

describe("current shadcn primitives", () => {
  it("pins the composite Radix Nova registry style without a separate base", () => {
    expect(componentConfig.style).toBe("radix-nova");
    expect(componentConfig).not.toHaveProperty("base");
  });

  it("exposes the compact render-backed badge, button group, tabs, and scroll area parts", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Badge variant="muted">4 条</Badge>
        <ButtonGroup aria-label="分页操作">
          <Button variant="ghost" size="icon-sm" aria-label="上一项" />
          <ButtonGroupSeparator />
          <Button variant="ghost" size="icon-sm" aria-label="下一项" />
        </ButtonGroup>
        <Tabs defaultValue="all">
          <TabsList aria-label="筛选">
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="unread">未读</TabsTrigger>
          </TabsList>
          <TabsContent value="all">全部内容</TabsContent>
          <TabsContent value="unread">未读内容</TabsContent>
        </Tabs>
        <ScrollArea aria-label="滚动内容" className="h-20">
          <div className="h-40">长内容</div>
        </ScrollArea>
      </>,
    );

    expect(screen.getByText("4 条")).toHaveAttribute("data-slot", "badge");
    expect(screen.getByRole("group", { name: "分页操作" })).toHaveAttribute(
      "data-orientation",
      "horizontal",
    );
    expect(screen.getByText("全部内容")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "未读" }));
    expect(screen.getByText("未读内容")).toBeVisible();
    expect(screen.getByLabelText("滚动内容")).toHaveAttribute(
      "data-slot",
      "scroll-area",
    );
  });

  it("uses a shadowless Nova Card surface with default and small spacing", () => {
    render(
      <>
        <Card aria-label="默认卡片">
          <CardHeader>
            <CardTitle>默认标题</CardTitle>
            <CardDescription>默认描述</CardDescription>
            <CardAction>默认操作</CardAction>
          </CardHeader>
          <CardContent>默认内容</CardContent>
          <CardFooter>默认页脚</CardFooter>
        </Card>
        <Card aria-label="紧凑卡片" size="sm">
          紧凑内容
        </Card>
      </>,
    );

    const card = screen.getByRole("generic", { name: "默认卡片" });
    expect(card).toHaveAttribute("data-size", "default");
    expect(card).toHaveClass(
      "bg-card",
      "rounded-xl",
      "ring-1",
      "ring-foreground/10",
      "[--card-spacing:--spacing(4)]",
    );
    expect(card).not.toHaveClass("shadow", "shadow-sm", "shadow-md");
    expect(screen.getByText("默认标题")).toHaveClass(
      "text-base",
      "leading-snug",
      "font-medium",
    );
    expect(screen.getByText("默认操作")).toHaveAttribute(
      "data-slot",
      "card-action",
    );
    expect(screen.getByText("默认页脚")).toHaveClass("bg-muted/50", "border-t");
    expect(screen.getByRole("generic", { name: "紧凑卡片" })).toHaveClass(
      "data-[size=sm]:[--card-spacing:--spacing(3)]",
    );
  });

  it("uses shared Item and Field typography with semantic separators", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <ItemGroup aria-label="项目列表">
          <Item>
            <ItemContent>
              <ItemTitle>项目标题</ItemTitle>
              <ItemDescription>项目描述</ItemDescription>
            </ItemContent>
          </Item>
          <ItemSeparator />
          <Item asChild>
            <a href="#linked">链接项目</a>
          </Item>
          <Item asChild>
            <button type="button" aria-pressed="true" onClick={onAction}>
              <ItemContent>
                <ItemTitle>已选择项目</ItemTitle>
                <ItemDescription>保留描述</ItemDescription>
              </ItemContent>
              <ItemActions>操作</ItemActions>
            </button>
          </Item>
        </ItemGroup>
        <Field>
          <FieldContent>
            <FieldLabel>设置标题</FieldLabel>
            <FieldDescription>设置描述</FieldDescription>
          </FieldContent>
        </Field>
      </>,
    );

    expect(screen.getByText("项目标题")).toHaveClass(
      "text-sm",
      "leading-snug",
      "font-medium",
    );
    expect(screen.getByText("项目描述")).toHaveClass(
      "text-sm",
      "leading-normal",
      "text-left",
    );
    expect(document.querySelector('[data-slot="item-separator"]')).toHaveClass(
      "data-[orientation=horizontal]:h-px",
      "bg-border",
      "my-2",
    );
    expect(screen.getByRole("link", { name: "链接项目" })).toHaveClass(
      "[a]:hover:bg-muted",
      "focus-visible:ring-1",
    );
    const selected = screen.getByRole("button", { name: /已选择项目/ });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveClass(
      "[button]:hover:bg-muted",
      "aria-pressed:bg-muted",
      "focus-visible:ring-1",
    );
    await user.click(selected);
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByText("操作")).toHaveAttribute(
      "data-slot",
      "item-actions",
    );
    expect(screen.getByText("设置标题")).toHaveClass(
      "text-base",
      "leading-[22px]",
      "font-medium",
    );
    expect(screen.getByText("设置描述")).toHaveClass("text-sm", "leading-5");
  });

  it("preserves the Electron Dialog exceptions and waits for every modal token", async () => {
    const navigated = vi.fn();

    function Harness() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(true);
      const { modalCount, requestNavigationAfterModals } =
        useModalCoordinator();
      return (
        <>
          <output aria-label="模态数量">{modalCount}</output>
          <button onClick={() => requestNavigationAfterModals(navigated)}>
            授权导航
          </button>
          <button onClick={() => setFirst(false)}>关闭第一层</button>
          <button onClick={() => setSecond(false)}>关闭第二层</button>
          <Dialog open={first} onOpenChange={setFirst}>
            <DialogContent>
              <DialogTitle>第一层</DialogTitle>
            </DialogContent>
          </Dialog>
          <Dialog open={second} onOpenChange={setSecond}>
            <DialogContent>
              <DialogTitle>第二层</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      );
    }

    render(
      <ModalCoordinatorProvider>
        <Harness />
      </ModalCoordinatorProvider>,
    );
    expect(await screen.findByLabelText("模态数量")).toHaveTextContent("2");
    for (const overlay of document.querySelectorAll(
      '[data-slot="dialog-overlay"]',
    )) {
      expect(overlay).toHaveClass(
        "bg-black/10",
        "supports-backdrop-filter:backdrop-blur-xs",
      );
    }
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      expect(dialog).toHaveClass("rounded-xl", "ring-1", "ring-foreground/10");
      expect(dialog).not.toHaveClass("border");
      expect(dialog).not.toHaveClass("shadow-lg");
      const close = within(dialog as HTMLElement).getByRole("button", {
        name: "关闭",
        hidden: true,
      });
      expect(close).toHaveAttribute("data-variant", "ghost");
      expect(close).toHaveAttribute("data-size", "icon-sm");
      expect(close).toHaveClass("hover:bg-accent");
    }
    fireEvent.click(
      screen.getByRole("button", { name: "授权导航", hidden: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "关闭第一层", hidden: true }),
    );
    expect(navigated).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "关闭第二层", hidden: true }),
    );
    expect(navigated).toHaveBeenCalledOnce();
  });

  it("keeps application blockers open and discards pending modal navigation", async () => {
    const navigated = vi.fn();
    const user = userEvent.setup();

    function Harness() {
      const [ordinaryOpen, setOrdinaryOpen] = useState(true);
      const [blocked, setBlocked] = useState(false);
      const { applicationBlocked, requestNavigationAfterModals } =
        useModalCoordinator();
      return (
        <>
          <output aria-label="应用阻塞状态">
            {applicationBlocked ? "阻塞" : "可用"}
          </output>
          <button onClick={() => requestNavigationAfterModals(navigated)}>
            授权导航
          </button>
          <button onClick={() => setBlocked(true)}>启用阻塞器</button>
          <button onClick={() => setBlocked(false)}>解除阻塞器</button>
          <button onClick={() => setOrdinaryOpen(false)}>关闭普通对话框</button>
          <Dialog open={ordinaryOpen} onOpenChange={setOrdinaryOpen}>
            <DialogContent>
              <DialogTitle>普通对话框</DialogTitle>
            </DialogContent>
          </Dialog>
          <ApplicationBlocker
            open={blocked}
            title="需要先处理本机资料库"
            description="请重新检查资料库状态。"
          >
            <button type="button">重新检查</button>
          </ApplicationBlocker>
        </>
      );
    }

    render(
      <ModalCoordinatorProvider>
        <Harness />
      </ModalCoordinatorProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "授权导航", hidden: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "启用阻塞器", hidden: true }),
    );
    expect(await screen.findByLabelText("应用阻塞状态")).toHaveTextContent(
      "阻塞",
    );

    const blocker = screen.getByRole("dialog", {
      name: "需要先处理本机资料库",
    });
    expect(blocker).toHaveTextContent("请重新检查资料库状态。");
    expect(
      within(blocker).queryByRole("button", { name: "关闭", hidden: true }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(blocker).toBeInTheDocument();
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    fireEvent.pointerDown(overlays.item(overlays.length - 1));
    expect(blocker).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "关闭普通对话框", hidden: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "解除阻塞器", hidden: true }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "需要先处理本机资料库" }),
      ).not.toBeInTheDocument();
    });
    expect(navigated).not.toHaveBeenCalled();
  });

  it("preserves the Electron Sheet mask, surface, and close recipe", async () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>详情面板</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    const sheet = await screen.findByRole("dialog", { name: "详情面板" });
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "bg-black/10",
      "supports-backdrop-filter:backdrop-blur-xs",
    );
    expect(sheet).toHaveClass(
      "bg-popover",
      "text-popover-foreground",
      "duration-200",
    );
    expect(sheet).not.toHaveClass("shadow-lg", "shadow-md");
    const close = within(sheet).getByRole("button", { name: "Close" });
    expect(close).toHaveAttribute("data-variant", "ghost");
    expect(close).toHaveAttribute("data-size", "icon-sm");
    expect(close).toHaveClass("hover:bg-accent");
  });

  it("keeps the mobile Sidebar Sheet close hidden without changing desktop state", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
      writable: true,
    });
    const onOpenChange = vi.fn();
    render(
      <SidebarProvider
        open
        onOpenChange={onOpenChange}
        persistState={false}
        enableKeyboardShortcut={false}
      >
        <SidebarTrigger aria-label="打开移动侧栏" />
        <Sidebar>移动侧栏内容</Sidebar>
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开移动侧栏" }));
    const mobileSidebar = await screen.findByText("移动侧栏内容");
    const sheet = mobileSidebar.closest('[data-mobile="true"]');
    expect(sheet).toHaveClass("[&>button]:hidden");
    expect(
      within(sheet as HTMLElement).getByRole("button", { name: "Close" }),
    ).toHaveAttribute("data-variant", "ghost");

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves the shadowless Nova Popover recipe", async () => {
    render(
      <Popover open>
        <PopoverTrigger>打开浮层</PopoverTrigger>
        <PopoverContent>浮层内容</PopoverContent>
      </Popover>,
    );

    const content = await screen.findByText("浮层内容");
    expect(content).toHaveAttribute("data-align", "center");
    expect(content).toHaveClass(
      "w-72",
      "rounded-lg",
      "bg-popover",
      "p-2.5",
      "ring-1",
      "data-[state=open]:animate-in",
      "data-[state=closed]:animate-out",
    );
    expect(content).not.toHaveClass("shadow-md");
  });

  it("keeps long Tooltip content constrained with its arrow and state classes", async () => {
    render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>提示目标</TooltipTrigger>
          <TooltipContent>
            这是一段需要保持在受约束浮层中的较长提示内容，用于验证不会无限扩宽。
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const content = await screen.findByRole("tooltip");
    expect(content).toHaveClass(
      "max-w-xs",
      "gap-1.5",
      "data-[state=delayed-open]:animate-in",
      "data-[state=closed]:animate-out",
    );
    expect(content.querySelector('[data-slot="tooltip-arrow"]')).not.toBeNull();
    expect(content).not.toHaveClass("shadow-md", "shadow-lg");
  });

  it("keeps DropdownMenu on the shadowless Nova surface", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>打开操作菜单</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive">删除项目</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = await screen.findByRole("menu");
    expect(content).toHaveAttribute("data-align", "start");
    expect(content).toHaveClass(
      "rounded-lg",
      "bg-popover/70",
      "ring-1",
      "ring-foreground/10",
      "duration-100",
    );
    expect(content).not.toHaveClass("border", "shadow-md", "shadow-lg");

    const destructive = screen.getByRole("menuitem", { name: "删除项目" });
    expect(destructive).toHaveAttribute("data-variant", "destructive");
    expect(destructive).toHaveClass(
      "data-[variant=destructive]:text-destructive",
      "data-[variant=destructive]:focus:bg-destructive/10",
    );
  });

  it("forwards controlled Select values on the shadowless Nova surface", async () => {
    const onValueChange = vi.fn();

    function Harness() {
      const [value, setValue] = useState("deepseek");
      return (
        <Select
          open
          value={value}
          onValueChange={(nextValue) => {
            onValueChange(nextValue);
            setValue(nextValue);
          }}
        >
          <SelectTrigger aria-label="AI 提供商">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deepseek">DeepSeek</SelectItem>
            <SelectItem value="disabled" disabled>
              不可用提供商
            </SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    render(<Harness />);
    const trigger = screen.getByLabelText("AI 提供商");
    const content = await screen.findByRole("listbox");
    expect(content).toHaveAttribute("data-align-trigger", "true");
    expect(content).toHaveClass(
      "rounded-lg",
      "bg-popover/70",
      "ring-1",
      "ring-foreground/10",
      "duration-100",
    );
    expect(content).not.toHaveClass("border", "shadow-md", "shadow-lg");
    expect(
      screen.getByRole("option", { name: "不可用提供商" }),
    ).toHaveAttribute("data-disabled");

    fireEvent.click(screen.getByRole("option", { name: "OpenAI" }));
    expect(onValueChange).toHaveBeenCalledWith("openai");
    expect(trigger).toHaveTextContent("OpenAI");
  });

  it("keeps nav menu width, side, and alignment as layout-only overrides", async () => {
    const user = userEvent.setup();

    render(
      <SidebarProvider defaultOpen persistState={false}>
        <NavProjects
          projects={[{ name: "本地项目", url: "#local", icon: BoxesIcon }]}
        />
        <NavUser
          user={{ name: "测试用户", email: "user@example.com", avatar: "" }}
        />
        <TeamSwitcher
          teams={[
            { name: "工作区 A", logo: BoxesIcon, plan: "专业版" },
            { name: "工作区 B", logo: BoxesIcon, plan: "团队版" },
          ]}
        />
      </SidebarProvider>,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    let menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "right");
    expect(menu).toHaveAttribute("data-align", "start");
    expect(menu).toHaveClass("w-48", "rounded-lg");
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("button", { name: /测试用户 user@example.com/ }),
    );
    menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "right");
    expect(menu).toHaveAttribute("data-align", "end");
    expect(menu).toHaveClass(
      "w-(--radix-dropdown-menu-trigger-width)",
      "min-w-56",
      "rounded-lg",
    );
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: /工作区 A 专业版/ }));
    menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "right");
    expect(menu).toHaveAttribute("data-align", "start");
    expect(menu).toHaveClass(
      "w-(--radix-dropdown-menu-trigger-width)",
      "min-w-56",
      "rounded-lg",
    );
    await user.click(screen.getByRole("menuitem", { name: /工作区 B/ }));
    expect(
      screen.getByRole("button", { name: /工作区 B 团队版/ }),
    ).toBeVisible();
  });

  it("uses the Electron thin-focus rule for Sidebar menu actions", () => {
    render(
      <SidebarProvider defaultOpen persistState={false}>
        <Sidebar>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>音频</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </Sidebar>
      </SidebarProvider>,
    );

    const action = screen.getByRole("button", { name: "音频" });
    expect(action).toHaveClass("focus-visible:ring-1");
    expect(action).not.toHaveClass("focus-visible:ring-2");
  });

  it("lets controlled Sidebar consumers bypass cookie persistence and the shortcut", async () => {
    const onOpenChange = vi.fn();
    const cookieSetter = vi.spyOn(document, "cookie", "set");
    const user = userEvent.setup();

    render(
      <ControlledSidebar
        onOpenChange={onOpenChange}
        persistState={false}
        enableKeyboardShortcut={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "切换侧栏" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(cookieSetter).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(onOpenChange).toHaveBeenCalledOnce();
  });

  it("retains the official cookie and keyboard defaults", () => {
    const onOpenChange = vi.fn();
    const cookieSetter = vi.spyOn(document, "cookie", "set");
    render(<ControlledSidebar onOpenChange={onOpenChange} />);

    fireEvent.keyDown(window, { key: "b", metaKey: true });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(cookieSetter).toHaveBeenCalledWith(
      "sidebar_state=false; path=/; max-age=604800",
    );
  });

  it("lets an official SidebarTrigger control an independent pane", async () => {
    const onOpenChange = vi.fn();
    const onPaneToggle = vi.fn();
    const user = userEvent.setup();

    render(
      <SidebarProvider open onOpenChange={onOpenChange} persistState={false}>
        <SidebarTrigger
          aria-label="切换上下文面板"
          toggleSidebarOnClick={false}
          onClick={onPaneToggle}
        />
      </SidebarProvider>,
    );

    await user.click(screen.getByRole("button", { name: "切换上下文面板" }));

    expect(onPaneToggle).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps small-control geometry with Nova hit zones and thin focus", () => {
    render(
      <div>
        <Label htmlFor="enabled-checkbox">启用复选项</Label>
        <Checkbox id="enabled-checkbox" />
        <Label htmlFor="enabled-switch">启用开关</Label>
        <Switch id="enabled-switch" />
        <Slider aria-label="范围" defaultValue={[20, 80]} />
      </div>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "启用复选项" });
    expect(checkbox).toHaveClass(
      "relative",
      "size-4",
      "after:-inset-x-3",
      "after:-inset-y-2",
      "enabled:hover:ring-1",
      "enabled:active:ring-1",
      "focus-visible:ring-1",
    );
    const toggle = screen.getByRole("switch", { name: "启用开关" });
    expect(toggle).toHaveClass(
      "relative",
      "data-[size=default]:h-[1.15rem]",
      "data-[size=default]:w-8",
      "after:-inset-x-3",
      "after:-inset-y-2",
      "enabled:hover:ring-1",
      "enabled:active:ring-1",
      "focus-visible:ring-1",
    );
    for (const thumb of screen.getAllByRole("slider", { name: "范围" })) {
      expect(thumb).toHaveClass(
        "relative",
        "size-4",
        "after:-inset-2",
        "hover:ring-1",
        "active:ring-1",
        "focus-visible:ring-1",
      );
    }
  });

  it("forwards controlled RadioGroup values with the Electron thin-focus exception", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();

    function ControlledRadioGroup() {
      const [value, setValue] = useState("deepseek");
      return (
        <RadioGroup
          aria-label="云端模型"
          value={value}
          onValueChange={(nextValue) => {
            setValue(nextValue);
            onValueChange(nextValue);
          }}
        >
          <RadioGroupItem value="deepseek" aria-label="DeepSeek" />
          <RadioGroupItem value="team" aria-label="Team" />
        </RadioGroup>
      );
    }

    render(<ControlledRadioGroup />);

    const deepseek = screen.getByRole("radio", { name: "DeepSeek" });
    const team = screen.getByRole("radio", { name: "Team" });
    expect(deepseek).toBeChecked();
    expect(team).toHaveClass("focus-visible:ring-1");
    expect(team).not.toHaveClass("focus-visible:ring-3", "shadow-xs");

    await user.click(team);

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith("team");
    expect(team).toBeChecked();
    expect(deepseek).not.toBeChecked();
  });

  it("forwards controlled Slider values and aria text to every thumb", () => {
    render(
      <Slider
        aria-label="剪辑范围"
        aria-valuetext="已选范围"
        min={0}
        max={100}
        step={5}
        value={[20, 80]}
      />,
    );
    const thumbs = screen.getAllByRole("slider", { name: "剪辑范围" });
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute("aria-valuenow", "20");
    expect(thumbs[1]).toHaveAttribute("aria-valuenow", "80");
    for (const thumb of thumbs) {
      expect(thumb).toHaveAttribute("aria-valuetext", "已选范围");
    }
  });

  it("pins invalid and read-only Input and Textarea recipe classes", () => {
    render(
      <div>
        <Input aria-label="无效输入" aria-invalid="true" />
        <Input aria-label="只读输入" readOnly value="固定值" />
        <Textarea aria-label="无效文本域" aria-invalid="true" />
        <Textarea aria-label="只读文本域" readOnly value="固定文本" />
      </div>,
    );

    const invalidInput = screen.getByRole("textbox", { name: "无效输入" });
    expect(invalidInput).toHaveAttribute("aria-invalid", "true");
    expect(invalidInput).toHaveClass(
      "aria-invalid:border-destructive",
      "aria-invalid:ring-1",
    );

    const readOnlyInput = screen.getByRole("textbox", { name: "只读输入" });
    expect(readOnlyInput).toHaveAttribute("readonly");
    expect(readOnlyInput).toHaveClass("read-only:cursor-default");

    const invalidTextarea = screen.getByRole("textbox", {
      name: "无效文本域",
    });
    expect(invalidTextarea).toHaveAttribute("aria-invalid", "true");
    expect(invalidTextarea).toHaveClass(
      "aria-invalid:border-destructive",
      "aria-invalid:ring-1",
    );
    const readOnlyTextarea = screen.getByRole("textbox", {
      name: "只读文本域",
    });
    expect(readOnlyTextarea).toHaveAttribute("readonly");
    expect(readOnlyTextarea).toHaveClass("read-only:cursor-default");
  });
});
