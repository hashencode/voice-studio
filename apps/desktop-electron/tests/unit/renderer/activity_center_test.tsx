// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityContextPane,
  ActivityContextPaneHead,
  ActivityMainWorkspace,
  type ActivityItemView,
} from "../../../src/renderer/features/activity/activity-center";

const failed: ActivityItemView = {
  id: "failed",
  kind: "processing_runtime_unavailable",
  safeSummary: "本地处理组件暂不可用。",
  occurrenceCount: 2,
  unread: true,
  settingsTarget: "local-models",
  lastOccurredAt: Date.UTC(2026, 7, 19, 3, 20),
};

describe("activity pages", () => {
  it("uses the shared empty state in the message list", () => {
    render(
      <ActivityContextPane items={[]} selectedId={null} onSelect={vi.fn()} />,
    );
    const empty = screen
      .getByText("暂无消息")
      .closest<HTMLElement>('[data-slot="empty-state"]')!;
    expect(empty).toBeVisible();
    expect(empty).toHaveTextContent("暂无消息");
    expect(within(empty).queryByRole("heading")).toBeNull();
    expect(
      empty
        .querySelector('[data-slot="empty-state-graphic"]')
        ?.querySelectorAll('[data-slot="empty-state-cube"]'),
    ).toHaveLength(3);
  });

  it("keeps the detail column blank when the message collection is empty", () => {
    render(
      <ActivityMainWorkspace
        item={null}
        hasItems={false}
        onOpenSettingsTarget={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();
    expect(screen.queryByRole("region", { name: "消息详情" })).toBeNull();
  });

  it("uses a local selection prompt when messages exist without a selection", () => {
    render(
      <ActivityMainWorkspace
        item={null}
        hasItems
        onOpenSettingsTarget={vi.fn()}
      />,
    );
    const empty = screen
      .getByText("请选择左侧消息")
      .closest<HTMLElement>('[data-slot="empty-state"]')!;
    expect(empty).toBeVisible();
    expect(
      empty.querySelector('[data-slot="full-screen-empty-state-preview"]'),
    ).toBeNull();
    expect(within(empty).queryByRole("heading")).toBeNull();
    expect(within(empty).queryByRole("button")).toBeNull();
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
        <ActivityMainWorkspace
          item={failed}
          hasItems
          onOpenSettingsTarget={openDetails}
        />
      </>,
    );
    const user = userEvent.setup();
    const messageRow = screen.getByRole("button", {
      name: /本地处理组件暂不可用/,
    });
    expect(messageRow).toHaveAttribute("data-slot", "item");
    expect(messageRow).toHaveAttribute("data-variant", "context");
    expect(messageRow).toHaveAttribute("aria-current", "true");
    expect(messageRow.querySelector('[data-slot="item-media"]')).not.toBeNull();
    await user.click(messageRow);
    expect(select).toHaveBeenCalledWith(failed);
    expect(select).toHaveBeenCalledOnce();
    const detail = screen.getByRole("region", { name: "消息详情" });
    expect(detail).toHaveTextContent("发生次数2");
    expect(detail).toHaveTextContent("需要处理");
    await user.click(screen.getByRole("button", { name: "前往本地模型设置" }));
    expect(openDetails).toHaveBeenCalledWith(failed);
  });

  it("renders every retained message in authoritative order without search or filters", () => {
    const complete: ActivityItemView = {
      ...failed,
      id: "complete",
      kind: "startup_reconciliation_failed",
      safeSummary: "Project Alpha",
      occurrenceCount: 1,
      unread: false,
      settingsTarget: null,
    };
    render(
      <ActivityContextPane
        items={[failed, complete]}
        selectedId="failed"
        onSelect={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("本地处理组件暂不可用。");
    expect(rows[1]).toHaveTextContent("Project Alpha");
    expect(within(rows[0]!).getByLabelText("未读")).toBeVisible();
    expect(within(rows[1]!).queryByLabelText("未读")).toBeNull();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "消息筛选" }),
    ).not.toBeInTheDocument();
  });

  it("marks all only from the pane head action", async () => {
    const markAll = vi.fn();
    render(
      <ActivityContextPaneHead
        unreadCount={2}
        markAllPending={false}
        onMarkAllRead={markAll}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "全部标记为已读" }));
    expect(markAll).toHaveBeenCalledOnce();
  });

  it("keeps the all-read action disabled without unread items and exposes failures", () => {
    render(
      <>
        <ActivityContextPaneHead
          unreadCount={0}
          markAllPending={false}
          onMarkAllRead={vi.fn()}
        />
        <ActivityContextPane
          items={[{ ...failed, unread: false }]}
          selectedId="failed"
          onSelect={vi.fn()}
          operationError="操作失败，请重试"
        />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "全部标记为已读" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请重试");
  });

  it("does not expose file context in application error details", () => {
    render(
      <ActivityMainWorkspace
        item={failed}
        hasItems
        onOpenSettingsTarget={vi.fn()}
      />,
    );
    const detail = screen.getByRole("region", { name: "消息详情" });
    expect(detail).not.toHaveTextContent("录制详情");
    expect(detail).not.toHaveTextContent("capture-failed");
    expect(detail).not.toHaveTextContent("/Users/private/recording.wav");
  });
});
