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
    const empty = screen.getByRole("heading", {
      name: "暂无消息",
    }).parentElement!;
    expect(empty).toBeVisible();
    expect(empty).toHaveTextContent("暂无消息");
    expect(empty.querySelector("svg.lucide-sprout")).not.toBeNull();
  });

  it("uses an empty state when no message is selected", () => {
    render(<ActivityMainWorkspace item={null} onOpenDetails={vi.fn()} />);
    const empty = screen.getByRole("heading", {
      name: "请选择消息",
    }).parentElement!;
    expect(empty).toHaveTextContent("请选择消息");
    expect(empty.querySelector("p")).toBeNull();
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
    const messageRow = screen.getByRole("button", { name: /录制需要处理/ });
    expect(messageRow).toHaveAttribute("data-slot", "item");
    expect(messageRow.querySelector('[data-slot="item-media"]')).not.toBeNull();
    await user.click(messageRow);
    expect(select).toHaveBeenCalledWith(failed);
    const detail = screen.getByRole("region", { name: "消息详情" });
    expect(detail).not.toHaveTextContent("录制需要处理");
    expect(detail).not.toHaveTextContent("这次录制未能正常完成");
    expect(detail).toHaveTextContent("需要处理");
    await user.click(screen.getByRole("button", { name: "打开录制详情" }));
    expect(openDetails).toHaveBeenCalledWith(failed);
  });

  it("filters titles locally without changing selection and marks all only from MailOpen", async () => {
    const complete: ActivityItemView = {
      ...failed,
      id: "complete",
      kind: "capture_completed",
      title: "Project Alpha",
      severity: "info",
    };
    const select = vi.fn();
    const markAll = vi.fn();
    render(
      <ActivityContextPane
        items={[failed, complete]}
        selectedId="failed"
        onSelect={select}
        unreadCount={2}
        onMarkAllRead={markAll}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("searchbox", { name: "搜索消息" }),
      "ALPHA",
    );
    expect(screen.queryByText("录制需要处理")).not.toBeInTheDocument();
    expect(screen.getByText("Project Alpha")).toBeVisible();
    expect(select).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("searchbox", { name: "搜索消息" }));
    await user.click(screen.getByRole("button", { name: "全部标记为已读" }));
    expect(markAll).toHaveBeenCalledOnce();
  });

  it("keeps the all-read action disabled without unread items and exposes failures", () => {
    render(
      <ActivityContextPane
        items={[{ ...failed, read: true }]}
        selectedId="failed"
        onSelect={vi.fn()}
        unreadCount={0}
        operationError="操作失败，请重试"
      />,
    );
    expect(
      screen.getByRole("button", { name: "全部标记为已读" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请重试");
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
      "这次录制未完成",
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
