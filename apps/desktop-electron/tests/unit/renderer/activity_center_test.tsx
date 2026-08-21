// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityCenter } from "../../../src/renderer/features/activity/activity-center";

describe("activity center", () => {
  it("shows a reusable empty state in the message surface", async () => {
    render(
      <ActivityCenter
        items={[]}
        onAcknowledgeThrough={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "消息" }));
    expect(
      await screen.findByRole("status", { name: "暂无消息" }),
    ).toBeVisible();
  });

  it("acknowledges through the newest visible item and opens details", async () => {
    const acknowledge = vi.fn();
    const openDetails = vi.fn();
    render(
      <ActivityCenter
        items={[
          {
            id: "newest",
            kind: "capture_failed",
            title: "录制需要处理",
            severity: "warning",
            read: false,
            captureSessionId: "capture-newest",
            createdAt: Date.UTC(2026, 7, 19, 3, 20),
          },
          {
            id: "older",
            kind: "capture_completed",
            title: "录制已保存",
            severity: "info",
            read: false,
            captureSessionId: "capture-older",
            createdAt: Date.UTC(2026, 7, 19, 2, 20),
          },
        ]}
        onAcknowledgeThrough={acknowledge}
        onOpenDetails={openDetails}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "消息，2 条未读" }));
    expect(acknowledge).toHaveBeenCalledWith("newest");
    await user.click(screen.getByRole("button", { name: /录制需要处理/ }));
    expect(screen.getByRole("region", { name: "消息详情" })).toHaveTextContent(
      "这次录制未能正常完成",
    );
    expect(openDetails).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "打开录制详情" }));
    expect(openDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: "newest" }),
    );
  });

  it("acknowledges the newest persistent message", async () => {
    const acknowledge = vi.fn();
    render(
      <ActivityCenter
        items={[
          {
            id: "newest",
            kind: "capture_failed",
            title: "录制需要处理",
            severity: "warning",
            read: false,
            captureSessionId: "capture-newest",
            createdAt: Date.UTC(2026, 7, 19, 3, 20),
          },
          {
            id: "persistent",
            kind: "capture_completed",
            title: "录制已保存",
            severity: "info",
            read: false,
            captureSessionId: "capture-persistent",
            createdAt: Date.UTC(2026, 7, 19, 2, 20),
          },
        ]}
        onAcknowledgeThrough={acknowledge}
        onOpenDetails={vi.fn()}
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "消息，2 条未读" }));
    expect(acknowledge).toHaveBeenCalledWith("newest");
  });

  it("selects the newest message whenever the center reopens", async () => {
    const baseItems = [
      {
        id: "newest",
        kind: "capture_failed" as const,
        title: "录制需要处理",
        severity: "warning" as const,
        read: false,
        captureSessionId: "capture-newest",
        createdAt: Date.UTC(2026, 7, 19, 3, 20),
      },
      {
        id: "older",
        kind: "capture_completed" as const,
        title: "录制已保存",
        severity: "info" as const,
        read: true,
        captureSessionId: "capture-older",
        createdAt: Date.UTC(2026, 7, 19, 2, 20),
      },
    ];
    const props = {
      onAcknowledgeThrough: vi.fn(),
      onOpenDetails: vi.fn(),
    };
    const view = render(<ActivityCenter {...props} items={baseItems} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^消息/ }));
    await user.click(screen.getByRole("button", { name: /录制已保存/ }));
    expect(screen.getByRole("region", { name: "消息详情" })).toHaveTextContent(
      "录制已保存",
    );
    await user.click(screen.getByRole("button", { name: /^消息/ }));

    const replacement = {
      ...baseItems[0]!,
      id: "replacement",
      title: "新的录制异常",
      captureSessionId: "capture-replacement",
    };
    view.rerender(
      <ActivityCenter {...props} items={[replacement, ...baseItems]} />,
    );
    await user.click(screen.getByRole("button", { name: /^消息/ }));
    expect(screen.getByRole("region", { name: "消息详情" })).toHaveTextContent(
      "新的录制异常",
    );
  });
});
