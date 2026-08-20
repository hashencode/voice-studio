// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityCenter } from "../../../src/renderer/features/activity/activity-center";

describe("activity center", () => {
  it("shows an empty global message surface", async () => {
    render(
      <ActivityCenter
        items={[]}
        onAcknowledgeThrough={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "消息" }));
    expect(await screen.findByText("暂无消息")).toBeVisible();
  });

  it("acknowledges through the newest visible item and opens details", async () => {
    const acknowledge = vi.fn();
    const openDetails = vi.fn();
    render(
      <ActivityCenter
        items={[
          {
            id: "newest",
            title: "录制需要处理",
            severity: "warning",
            read: false,
            captureSessionId: "capture-newest",
          },
          {
            id: "older",
            title: "录制已保存",
            severity: "info",
            read: false,
            captureSessionId: "capture-older",
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
            title: "录制需要处理",
            severity: "warning",
            read: false,
            captureSessionId: "capture-newest",
          },
          {
            id: "persistent",
            title: "录制已保存",
            severity: "info",
            read: false,
            captureSessionId: "capture-persistent",
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
});
