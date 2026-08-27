// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import {
  ModalCoordinatorProvider,
  useModalCoordinator,
} from "@/components/ui/modal-coordinator";

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
  it("uses the shared Goo typography and separators for list-like rows", () => {
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
          <Item>第二项</Item>
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
      "text-base",
      "leading-[22px]",
      "font-medium",
    );
    expect(screen.getByText("项目描述")).toHaveClass("text-sm", "leading-5");
    expect(document.querySelector('[data-slot="item-separator"]')).toHaveClass(
      "data-[orientation=horizontal]:h-px",
      "bg-border",
    );
    expect(screen.getByText("设置标题")).toHaveClass(
      "text-base",
      "leading-[22px]",
      "font-medium",
    );
    expect(screen.getByText("设置描述")).toHaveClass("text-sm", "leading-5");
  });

  it("shares the default modal overlay and waits for every modal token", async () => {
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

  it("exposes labels, values, and states for each migrated control", () => {
    render(
      <div>
        <Label htmlFor="provider">音频智能提供商</Label>
        <Select defaultValue="deepseek">
          <SelectTrigger id="provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deepseek">DeepSeek</SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
          </SelectContent>
        </Select>

        <Label htmlFor="caption-switch">同时生成字幕</Label>
        <Switch id="caption-switch" defaultChecked />

        <Label htmlFor="cloud-consent">允许云端处理</Label>
        <Checkbox id="cloud-consent" defaultChecked />

        <Label id="playback-position-label">播放位置</Label>
        <Slider
          id="playback-position"
          aria-labelledby="playback-position-label"
          min={0}
          max={120}
          step={5}
          value={[35]}
        />

        <Progress aria-label="处理进度" value={64} />

        <Label htmlFor="transcript">转写文本</Label>
        <Textarea id="transcript" defaultValue="测试转写" />
      </div>,
    );

    expect(
      screen.getByRole("combobox", { name: "音频智能提供商" }),
    ).toHaveTextContent("DeepSeek");
    expect(screen.getByRole("switch", { name: "同时生成字幕" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "允许云端处理" }),
    ).toBeChecked();
    expect(screen.getByRole("slider", { name: "播放位置" })).toHaveAttribute(
      "aria-valuenow",
      "35",
    );
    expect(screen.getByRole("slider", { name: "播放位置" })).toHaveAttribute(
      "aria-valuemax",
      "120",
    );
    expect(
      screen.getByRole("progressbar", { name: "处理进度" }),
    ).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByRole("textbox", { name: "转写文本" })).toHaveValue(
      "测试转写",
    );
  });
});
