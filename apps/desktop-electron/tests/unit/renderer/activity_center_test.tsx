// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityContextPane,
  ActivityErrorDialog,
  ActivityMainWorkspace,
  type ActivityItemView,
} from "../../../src/renderer/features/activity/activity-center";

const failed: ActivityItemView = {
  id: "failed",
  kind: "capture_failed",
  title: "录制需要处理",
  severity: "warning",
  read: false,
  captureSessionId: "capture-failed",
  createdAt: Date.UTC(2026, 7, 19, 3, 20),
};

describe("activity pages", () => {
  it("uses the shared empty state in the message list", () => {
    render(
      <ActivityContextPane items={[]} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("status", { name: "暂无消息" })).toBeVisible();
  });

  it("uses an empty state when no message is selected", () => {
    render(<ActivityMainWorkspace item={null} onOpenDetails={vi.fn()} />);
    expect(
      screen.getByRole("status", { name: "请选择消息" }),
    ).toHaveTextContent("选择左侧消息后，可在这里查看完整信息");
  });

  it("selects a summary from the second column and renders full detail", async () => {
    const select = vi.fn();
    const openDetails = vi.fn();
    render(
      <>
        <ActivityContextPane
          items={[failed]}
          selectedId="failed"
          onSelect={select}
        />
        <ActivityMainWorkspace item={failed} onOpenDetails={openDetails} />
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /录制需要处理/ }));
    expect(select).toHaveBeenCalledWith(failed);
    expect(screen.getByRole("region", { name: "消息详情" })).toHaveTextContent(
      "这次录制未能正常完成",
    );
    await user.click(screen.getByRole("button", { name: "打开录制详情" }));
    expect(openDetails).toHaveBeenCalledWith(failed);
  });

  it("shows failed capture information in a modal", async () => {
    const openDetails = vi.fn();
    render(
      <ActivityErrorDialog
        item={failed}
        open
        onOpenChange={vi.fn()}
        onOpenDetails={openDetails}
      />,
    );
    expect(screen.getByRole("dialog", { name: "录制需要处理" })).toBeVisible();
    expect(screen.getByLabelText("错误信息")).toHaveTextContent(
      "这次录制未能正常完成",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "打开录制详情" }));
    expect(openDetails).toHaveBeenCalledWith(failed);
  });

  it("closes a failed-capture modal for later handling", async () => {
    const onOpenChange = vi.fn();
    render(
      <ActivityErrorDialog
        item={failed}
        open
        onOpenChange={onOpenChange}
        onOpenDetails={vi.fn()}
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "稍后处理" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
