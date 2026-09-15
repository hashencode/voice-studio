// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityContextPane,
  ActivityContextPaneFilters,
  ActivityContextPaneSearch,
  ActivityMainWorkspace,
  type ActivityItemView,
} from "../../../src/renderer/features/activity/activity-center";
import { useState } from "react";

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
    const empty = screen.getByRole("heading", {
      name: "暂无消息",
    }).parentElement!;
    expect(empty).toBeVisible();
    expect(empty).toHaveTextContent("暂无消息");
    expect(empty.querySelector("svg.lucide-sprout")).not.toBeNull();
  });

  it("uses an empty state when no message is selected", () => {
    render(
      <ActivityMainWorkspace item={null} onOpenSettingsTarget={vi.fn()} />,
    );
    const empty = screen
      .getByRole("heading", { name: "还没有消息" })
      .closest<HTMLElement>('[data-slot="full-screen-empty-state"]')!;
    expect(empty).toBeVisible();
    expect(empty).toHaveTextContent("这里只显示需要跨页面关注的应用错误。");
    expect(
      empty.querySelector('[data-slot="full-screen-empty-state-illustration"]'),
    ).not.toBeNull();
    expect(
      empty.querySelector('[data-slot="full-screen-empty-state-graphic"]'),
    ).toBeInstanceOf(SVGElement);
    expect(
      empty
        .querySelector('[data-slot="full-screen-empty-state-graphic"]')
        ?.querySelectorAll("polygon"),
    ).toHaveLength(3);
    expect(empty.querySelector("svg.lucide-inbox")).toBeNull();
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

  it("filters titles locally without changing selection and marks all only from MailOpen", async () => {
    const complete: ActivityItemView = {
      ...failed,
      id: "complete",
      kind: "startup_reconciliation_failed",
      safeSummary: "Project Alpha",
      occurrenceCount: 1,
      settingsTarget: null,
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
    expect(
      screen.queryByText("本地处理组件暂不可用。"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Project Alpha")).toBeVisible();
    expect(select).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("searchbox", { name: "搜索消息" }));
    await user.click(screen.getByRole("button", { name: "全部标记为已读" }));
    expect(markAll).toHaveBeenCalledOnce();
  });

  it("combines real unread and attention counts with search", async () => {
    const complete: ActivityItemView = {
      ...failed,
      id: "complete",
      kind: "startup_reconciliation_failed",
      safeSummary: "Project Alpha",
      occurrenceCount: 1,
      unread: false,
      settingsTarget: null,
    };
    function Harness() {
      const [query, setQuery] = useState("");
      const [filter, setFilter] = useState<"all" | "unread">("all");
      return (
        <>
          <ActivityContextPaneSearch value={query} onValueChange={setQuery} />
          <ActivityContextPaneFilters
            items={[failed, complete]}
            value={filter}
            onValueChange={setFilter}
          />
          <ActivityContextPane
            items={[failed, complete]}
            selectedId="complete"
            onSelect={vi.fn()}
            query={query}
            filter={filter}
          />
        </>
      );
    }
    render(<Harness />);
    const user = userEvent.setup();

    const allFilter = screen.getByRole("button", { name: "全部 2" });
    expect(allFilter).toHaveAttribute("data-variant", "filter");
    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(allFilter.querySelector('[data-slot="badge"]')).toHaveTextContent(
      "2",
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索消息" })).toHaveAttribute(
      "data-variant",
      "context-search",
    );
    expect(screen.getByRole("button", { name: "未读 1" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "未读 1" }));
    expect(allFilter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "未读 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("本地处理组件暂不可用。")).toBeVisible();
    expect(screen.queryByText("Project Alpha")).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "搜索消息" }),
      "alpha",
    );
    expect(screen.getByText("没有匹配的消息")).toBeVisible();
  });

  it("keeps the all-read action disabled without unread items and exposes failures", () => {
    render(
      <ActivityContextPane
        items={[{ ...failed, unread: false }]}
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

  it("does not expose file context in application error details", () => {
    render(
      <ActivityMainWorkspace item={failed} onOpenSettingsTarget={vi.fn()} />,
    );
    const detail = screen.getByRole("region", { name: "消息详情" });
    expect(detail).not.toHaveTextContent("录制详情");
    expect(detail).not.toHaveTextContent("capture-failed");
    expect(detail).not.toHaveTextContent("/Users/private/recording.wav");
  });
});
