// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/renderer/App";
import type {
  ApplicationSnapshot,
  ShellSection,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";
import { companionRendererStubs } from "../fixtures/companion";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function applicationApi(
  initial: ApplicationSnapshot,
  overrides: Partial<Voice2TextDesktopApi> = {},
) {
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
    ...companionRendererStubs(),
    getAiSettings: vi.fn(async () => testAiSettings()),
    createAiProviderProfile: vi.fn(async () => testAiSettings()),
    updateAiProviderProfile: vi.fn(async () => testAiSettings()),
    selectAiProviderProfile: vi.fn(async () => testAiSettings()),
    deleteAiProviderProfile: vi.fn(async () => testAiSettings()),
    prepareAudioAi: vi.fn(),
    getAudioAiSnapshot: vi.fn(async () => null),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => []),
    importAudio: vi.fn(),
    listAudios: vi.fn(async () => []),
    openAudio: vi.fn(async () => null),
    searchTranscript: vi.fn(async () => []),
    editAudioSegment: vi.fn(),
    undoAudioEdit: vi.fn(),
    redoAudioEdit: vi.fn(),
    renameAudioSpeaker: vi.fn(),
    mergeAudioSpeakers: vi.fn(),
    assignAudioSpeaker: vi.fn(),
    controlAudioPlayback: vi.fn(),
    exportAudio: vi.fn(),
    preflightCapture: vi.fn(),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    listCaptureRecoveries: vi.fn(async () => []),
    actOnCaptureRecovery: vi.fn(),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    onCaptionSnapshot: vi.fn(() => () => undefined),
    onOperationEvent: vi.fn(() => () => undefined),
    getApplicationSnapshot: vi.fn(async () => snapshot),
    navigate,
    requestBootstrapAction: vi.fn(async () => snapshot),
    markActivityRead: vi.fn(async () => snapshot),
    markAllActivityRead: vi.fn(async () => snapshot),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return { api, navigate };
}

function testAiSettings() {
  return {
    revision: 1,
    profiles: [testAiProfile()],
    selectedProfileId: "profile-deepseek",
    deviceSecurity: {
      kind: "device-security" as const,
      fileVaultState: "unknown" as const,
      applicationLayerEncryption: "not-claimed" as const,
    },
  };
}

function testAiProfile() {
  return {
    profileId: "profile-deepseek",
    kind: "custom" as const,
    displayName: "DeepSeek",
    protocol: "deepseek" as const,
    modelId: "deepseek-chat",
    modelSummary: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
    endpointOrigin: "https://api.deepseek.com",
    processingLocation: "cloudDirect" as const,
    requiresConsent: true as const,
    capabilities: {
      selectable: true as const,
      editable: true as const,
      deletable: true as const,
    },
    secretState: "missing" as const,
  };
}

const restored: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 8,
  navigation: { section: "companion" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
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
  it("keeps native rail order, tooltips, selection and restored snapshots", async () => {
    const { api } = applicationApi(restored);
    const user = userEvent.setup();
    const first = render(createElement(App));

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    const companion = within(navigation).getByRole("button", {
      name: "互联",
    });
    const navigationButtons = within(navigation).getAllByRole("button");
    expect(
      navigationButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["音频", "互联", "消息", "设置"]);
    expect(companion).toHaveAttribute("aria-current", "page");
    expect(
      navigationButtons.every((button) => !button.hasAttribute("tabindex")),
    ).toBe(true);
    companion.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("互联");
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));

    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();

    first.unmount();
    render(createElement(App));
    expect(await screen.findByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
  });

  it.each(["tasks", "library"])(
    "normalizes the legacy /%s deep link to Audio once",
    async (legacySection) => {
      const { navigate } = applicationApi(restored);
      window.history.replaceState(null, "", `/#/${legacySection}`);
      render(createElement(App));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith("library"));
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#/audio");
      expect(
        await screen.findByRole("button", { name: "音频" }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        screen.queryByRole("button", { name: "转写任务" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { name: "音频上下文面板" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("complementary", { name: "录制控制" }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps the pane docked across widths without preference writes and preserves focus semantics", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 880,
      writable: true,
    });
    const withRecovery: ApplicationSnapshot = {
      ...restored,
      navigation: { section: "library" },
      reconciliation: [
        {
          kind: "capture",
          identity: "capture-880",
          state: "repairable",
          requiresExplicitAction: true,
        },
      ],
    };
    const { api } = applicationApi(withRecovery);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(createElement(App));

    const pane = await screen.findByRole("complementary", {
      name: "音频上下文面板",
    });
    const wrapper = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    )!;
    const outer = wrapper.querySelector<HTMLElement>(
      ':scope > [data-slot="sidebar"]',
    )!;
    const container = outer.querySelector<HTMLElement>(
      ':scope > [data-slot="sidebar-container"]',
    )!;
    expect(pane).toHaveAttribute("data-presentation", "docked");
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(container).toHaveAttribute("data-presentation", "docked");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "工作站主导航" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("启动恢复需要确认")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "消息" }));
    expect(
      screen.getByRole("complementary", { name: "消息上下文面板" }),
    ).toHaveTextContent("暂无消息");
    expect(writes).not.toHaveBeenCalled();

    window.innerWidth = 1280;
    window.dispatchEvent(new Event("resize"));
    expect(pane).toHaveAttribute("data-presentation", "docked");
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(container).toHaveAttribute("data-presentation", "docked");
    window.innerWidth = 880;
    window.dispatchEvent(new Event("resize"));
    expect(pane).toHaveAttribute("data-presentation", "docked");
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(api.listAudios).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();

    const settings = screen.getByRole("button", { name: "设置" });
    await user.click(settings);
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(writes).not.toHaveBeenCalled();

    const audio = screen.getByRole("button", { name: "音频" });
    await user.click(audio);
    expect(
      screen.queryByRole("button", { name: "关闭音频上下文面板" }),
    ).not.toBeInTheDocument();
    const collapse = screen.getByRole("button", {
      name: "收起音频上下文面板",
    });
    await user.click(collapse);
    expect(writes).toHaveBeenCalledTimes(1);
    const trigger = screen.getByRole("button", {
      name: "打开音频上下文面板",
    });
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(writes).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    expect(writes).toHaveBeenCalledTimes(3);
    const reopenedTrigger = screen.getByRole("button", {
      name: "打开音频上下文面板",
    });
    expect(reopenedTrigger).toHaveFocus();

    await user.click(reopenedTrigger);
    expect(writes).toHaveBeenCalledTimes(4);
    fireEvent.pointerDown(document.getElementById("main-content")!);
    expect(writes).toHaveBeenCalledTimes(4);
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
  });

  it("reveals message details while keeping a narrow pane docked", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 880,
      writable: true,
    });
    const markActivityRead = vi.fn(async () => restored);
    const markAllActivityRead = vi.fn(async () => restored);
    applicationApi(
      {
        ...restored,
        activity: [
          {
            id: "complete",
            kind: "capture_completed",
            captureSessionId: "capture-complete",
            createdAt: 2,
            title: "录制已保存",
            severity: "info",
            read: false,
            resolved: true,
            detailTarget: "capture-details",
          },
          {
            id: "failed",
            kind: "capture_failed",
            captureSessionId: "capture-failed",
            createdAt: 1,
            title: "录制失败",
            severity: "warning",
            read: false,
            resolved: false,
            detailTarget: "capture-details",
          },
        ],
      },
      { markActivityRead, markAllActivityRead },
    );
    const user = userEvent.setup();
    render(createElement(App));

    await user.click(
      await screen.findByRole("button", { name: "消息，2 条未读" }),
    );
    expect(markActivityRead).toHaveBeenCalledWith("complete");
    await user.click(screen.getByRole("button", { name: /录制已保存/ }));
    expect(
      screen.getByRole("complementary", { name: "消息上下文面板" }),
    ).toBeVisible();
    const messageDetails = screen.getByRole("region", { name: "消息详情" });
    expect(messageDetails).toHaveTextContent("已完成");
    expect(
      within(messageDetails).getByRole("button", { name: "打开录制详情" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /录制失败/ }));
    expect(
      document.querySelector('[aria-label="消息上下文面板"]'),
    ).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "录制失败" })).toBeVisible();
    expect(markActivityRead).toHaveBeenCalledWith("failed");
  });

  it("closes audio playback once when sidebar navigation unmounts the workspace", async () => {
    const audio = {
      revision: 3,
      summary: {
        audioId: 4,
        displayName: "项目周会.wav",
        durationMs: 6_000,
        createdAtMs: 1,
        processingState: "completed" as const,
        generationId: 9,
        generationKind: "formal" as const,
        segmentCount: 0,
      },
      segments: [],
      speakers: [],
      canUndo: false,
      canRedo: false,
    };
    const initial: ApplicationSnapshot = {
      ...restored,
      navigation: { section: "library" },
      library: { phase: "ready", audioCount: 1 },
      capture: { phase: "idle" },
    };
    const controlAudioPlayback = vi.fn(async () => ({
      audioId: 4,
      initialized: false,
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    }));
    applicationApi(initial, {
      listAudios: vi.fn(async () => [audio.summary]),
      openAudio: vi.fn(async () => audio),
      controlAudioPlayback,
    });
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(
      await screen.findByRole("button", { name: /打开 项目周会/ }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "项目周会.wav",
        level: 1,
      }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "互联" }));
    expect(
      await screen.findByRole("status", { name: "手机接收当前关闭" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(controlAudioPlayback).toHaveBeenCalledWith(4, {
        action: "close",
      }),
    );
    expect(controlAudioPlayback).toHaveBeenCalledTimes(1);
  });
});
