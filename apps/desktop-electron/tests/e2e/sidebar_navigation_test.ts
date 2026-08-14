// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/renderer/App";
import type {
  ApplicationSnapshot,
  ShellSection,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function applicationApi(initial: ApplicationSnapshot) {
  let snapshot = initial;
  const navigate = vi.fn(async (section: ShellSection) => {
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      navigation: { section },
    };
    return snapshot;
  });
  const api: Voice2TextDesktopApi = {
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => []),
    importMeeting: vi.fn(),
    onOperationEvent: vi.fn(() => () => undefined),
    getApplicationSnapshot: vi.fn(async () => snapshot),
    navigate,
    requestBootstrapAction: vi.fn(async () => snapshot),
    onApplicationSnapshot: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return { api, navigate };
}

const restored: ApplicationSnapshot = {
  protocolVersion: 1,
  revision: 8,
  navigation: { section: "companion" },
  profile: { phase: "ready" },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: {
    phase: "paused",
    sessionId: "capture-restored",
    title: "访谈",
    elapsedMs: 10_000,
  },
};

describe("sidebar navigation e2e", () => {
  it("supports roving arrow keys, collapse, selection and restored snapshots", async () => {
    const { api } = applicationApi(restored);
    const user = userEvent.setup();
    const first = render(createElement(App));

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    const companion = within(navigation).getByRole("button", {
      name: "Companion",
    });
    expect(companion).toHaveAttribute("aria-current", "page");
    companion.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      within(navigation).getByRole("button", { name: "设置" }),
    ).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "折叠侧边栏" }));
    expect(
      within(navigation).getByRole("button", { name: "设置" }),
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toBeVisible();

    first.unmount();
    render(createElement(App));
    expect(await screen.findByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toBeVisible();
  });

  it("honors a deep link once without creating duplicate operations", async () => {
    const { navigate } = applicationApi(restored);
    window.history.replaceState(null, "", "/#/tasks");
    render(createElement(App));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("tasks"));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", { name: "转写任务" }),
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toHaveTextContent("访谈");
  });
});
