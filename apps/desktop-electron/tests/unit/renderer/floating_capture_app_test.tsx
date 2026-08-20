// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FloatingCaptureApp } from "../../../src/floating-renderer/floating-capture-app";
import type { FloatingCaptureSnapshot } from "../../../src/shared/contracts";

const recording: FloatingCaptureSnapshot = {
  revision: 1,
  sessionId: "session-123456789012",
  phase: "recording",
  elapsedMs: 65_000,
  allowedActions: ["pause", "stop"],
  attention: false,
};

function installApi() {
  const api = {
    getSnapshot: vi.fn(async () => recording),
    control: vi.fn(async () => ({ ...recording, phase: "paused" as const })),
    windowAction: vi.fn(async () => recording),
    onSnapshot: vi.fn<
      (listener: (snapshot: FloatingCaptureSnapshot) => void) => () => void
    >(() => () => undefined),
  };
  Object.defineProperty(window, "voice2textFloating", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("floating capture app", () => {
  it("shows only privacy-safe state and canonical controls", async () => {
    const api = installApi();
    render(<FloatingCaptureApp />);
    expect(await screen.findByText("正在录制")).toBeVisible();
    expect(screen.getByText("01:05")).toBeVisible();
    expect(screen.getByRole("button", { name: "暂停录制" })).toBeVisible();
    expect(screen.getByRole("button", { name: "停止并保存" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "关闭桌面悬浮控制" }),
    );
    expect(api.windowAction).toHaveBeenCalledWith("turn-off");
    expect(document.body).not.toHaveTextContent(/标题|转写|路径/);
  });

  it("uses local two-step stop confirmation and Escape cancellation", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(<FloatingCaptureApp />);
    await screen.findByText("正在录制");
    await user.click(screen.getByRole("button", { name: "停止并保存" }));
    expect(screen.getByRole("button", { name: "确认停止" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("button", { name: "确认停止" }),
    ).not.toBeInTheDocument();
    expect(api.control).not.toHaveBeenCalled();
  });

  it("does not let a late initial snapshot replace a newer event", async () => {
    let resolveInitial: (value: FloatingCaptureSnapshot) => void = () =>
      undefined;
    const api = installApi();
    api.getSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );
    let publish: (value: FloatingCaptureSnapshot) => void = () => undefined;
    api.onSnapshot.mockImplementation((listener) => {
      publish = listener;
      return () => undefined;
    });
    render(<FloatingCaptureApp />);
    act(() => publish({ ...recording, revision: 2, phase: "paused" }));
    expect(await screen.findByText("录制已暂停")).toBeVisible();
    await act(async () => resolveInitial(recording));
    expect(screen.getByText("录制已暂停")).toBeVisible();
  });

  it("shows privacy-safe feedback when a control fails", async () => {
    const api = installApi();
    let publish: (value: FloatingCaptureSnapshot) => void = () => undefined;
    api.onSnapshot.mockImplementation((listener) => {
      publish = listener;
      return () => undefined;
    });
    api.control.mockRejectedValue(new Error("private native path"));
    const user = userEvent.setup();
    render(<FloatingCaptureApp />);
    await screen.findByText("正在录制");
    await user.click(screen.getByRole("button", { name: "暂停录制" }));
    expect(await screen.findByText("操作未完成")).toBeVisible();
    act(() => publish({ ...recording, revision: 2, elapsedMs: 65_500 }));
    expect(screen.getByText("操作未完成")).toBeVisible();
    expect(document.body).not.toHaveTextContent("private native path");
  });

  it("keeps a privacy-safe handoff when the initial snapshot fails", async () => {
    const api = installApi();
    api.getSnapshot.mockRejectedValue(new Error("private database path"));
    render(<FloatingCaptureApp />);
    expect(await screen.findByText("状态暂不可用")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开录制详情" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("private database path");
  });
});
