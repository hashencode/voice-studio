// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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
