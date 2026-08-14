// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
import type {
  ApplicationSnapshot,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const readySnapshot: ApplicationSnapshot = {
  protocolVersion: 1,
  revision: 4,
  navigation: { section: "library" },
  profile: { phase: "ready" },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: {
    phase: "recording",
    sessionId: "capture-7",
    title: "产品周会",
    elapsedMs: 72_000,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function installApi(
  snapshot: ApplicationSnapshot,
  overrides: Partial<Voice2TextDesktopApi> = {},
) {
  const api: Voice2TextDesktopApi = {
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    onOperationEvent: vi.fn(() => () => undefined),
    getApplicationSnapshot: vi.fn(async () => snapshot),
    navigate: vi.fn(async (section) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      navigation: { section },
    })),
    requestBootstrapAction: vi.fn(async () => snapshot),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("application shell", () => {
  it("restores navigation and keeps capture in an application-owned overlay", async () => {
    const api = installApi(readySnapshot);
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("status", { name: "正在加载工作台" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "还没有本机会议" }),
    ).toBeVisible();

    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    const library = within(navigation).getByRole("button", { name: "会议库" });
    expect(library).toHaveAttribute("aria-current", "page");

    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toHaveTextContent("产品周会");
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toBeVisible();
  });

  it("blocks writable actions while profile repair is required", async () => {
    const blocked: ApplicationSnapshot = {
      ...readySnapshot,
      profile: {
        phase: "blocked",
        code: "insufficient_space",
        message: "可用空间不足",
        repairable: true,
      },
      capture: { phase: "idle" },
    };
    const api = installApi(blocked);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("可用空间不足");
    expect(screen.getByRole("button", { name: "导入会议" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试初始化" }));
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("retry");
    await user.click(screen.getByRole("button", { name: "查看修复建议" }));
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("repair-guidance");
  });

  it.each([
    ["loading", "正在加载会议库"],
    ["error", "会议库暂时不可用"],
  ] as const)("renders the %s library surface", async (phase, heading) => {
    installApi({
      ...readySnapshot,
      capture: { phase: "idle" },
      library:
        phase === "error"
          ? { phase, message: "读取失败", retryable: true }
          : { phase },
    });
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
  });

  it("announces offline and unavailable capability without color-only meaning", async () => {
    installApi({
      ...readySnapshot,
      connectivity: "offline",
      capability: {
        processing: "unavailable",
        reason: "当前设备缺少本地处理运行时",
      },
      navigation: { section: "tasks" },
      capture: { phase: "idle" },
    });
    render(<App />);
    expect(
      await screen.findByRole("status", { name: "离线状态" }),
    ).toHaveTextContent("离线");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "当前设备缺少本地处理运行时",
    );
  });

  it("surfaces reconciliation as explicit recovery without auto-retry", async () => {
    installApi({
      ...readySnapshot,
      capture: { phase: "idle" },
      reconciliation: [
        {
          kind: "capture",
          identity: "capture-interrupted",
          state: "repairable",
          requiresExplicitAction: true,
        },
        {
          kind: "processing",
          identity: "job-41",
          state: "interrupted",
          requiresExplicitAction: true,
        },
      ],
    });
    render(<App />);
    const recovery = await screen.findByRole("alert");
    expect(recovery).toHaveTextContent("启动恢复需要确认");
    expect(recovery).toHaveTextContent("不会自动重试");
    expect(screen.getByRole("button", { name: "逐项检查" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "稍后处理" })).toBeEnabled();
  });
});
