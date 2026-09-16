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

const navigationAudio = {
  audioId: 1,
  displayName: "导航测试.wav",
  durationMs: 1_000,
  createdAtMs: 1,
  processingState: "completed" as const,
  generationId: null,
  generationKind: null,
  segmentCount: 0,
};

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
    listAudios: vi.fn(async () => [navigationAudio]),
    openAudio: vi.fn(async () => null),
    deleteAudio: vi.fn(async () => ({ deleted: true })),
    searchTranscript: vi.fn(async () => []),
    editAudioSegment: vi.fn(),
    updateAudioMetadata: vi.fn(),
    undoAudioEdit: vi.fn(),
    redoAudioEdit: vi.fn(),
    renameAudioSpeaker: vi.fn(),
    mergeAudioSpeakers: vi.fn(),
    assignAudioSpeaker: vi.fn(),
    controlAudioPlayback: vi.fn(),
    exportAudio: vi.fn(),
    preflightCapture: vi.fn(async () => ({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "dual_track" as const,
      systemAudioPermission: "granted" as const,
      microphonePermission: "granted" as const,
      microphones: [],
      availableBytes: 8 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    })),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    suggestCaptureTitle: vi.fn(async () => ({ title: "新录音2026090501" })),
    renameCaptureSession: vi.fn(async () => snapshot),
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
    retryCaptureLibraryProjection:
      overrides.retryCaptureLibraryProjection ?? vi.fn(async () => snapshot),
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
  protocolVersion: 3,
  revision: 8,
  navigation: { section: "companion" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: { phase: "idle" },
  libraryProjection: { phase: "idle" },
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

  it("restores the latest settings category after leaving the section", async () => {
    const { api } = applicationApi(restored);
    const user = userEvent.setup();
    render(createElement(App));

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));

    const settingsNavigation = screen.getByRole("navigation", {
      name: "设置分类",
    });
    const general = within(settingsNavigation).getByRole("button", {
      name: "通用",
    });
    const recording = within(settingsNavigation).getByRole("button", {
      name: "录制",
    });
    const localModels = within(settingsNavigation).getByRole("button", {
      name: "本地模型",
    });
    expect(general).toHaveAttribute("aria-current", "location");
    expect(
      within(settingsNavigation).queryByRole("link", { name: "通用" }),
    ).not.toBeInTheDocument();

    await user.click(recording);
    await user.click(localModels);
    expect(
      screen.getByRole("heading", { level: 1, name: "本地模型" }),
    ).toBeVisible();
    expect(localModels).toHaveAttribute("aria-current", "location");
    expect(
      document.querySelectorAll("[data-settings-section]:not([hidden])"),
    ).toHaveLength(1);

    await user.click(within(navigation).getByRole("button", { name: "音频" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("library"));
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "本地模型" }),
      ).toBeVisible(),
    );
    const restoredSettingsNavigation = screen.getByRole("navigation", {
      name: "设置分类",
    });
    expect(
      within(restoredSettingsNavigation).getByRole("button", {
        name: "本地模型",
      }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      document.querySelectorAll("[data-settings-section]:not([hidden])"),
    ).toHaveLength(1);

    expect(screen.queryByRole("button", { name: /返回/ })).toBeNull();
    await user.click(
      within(restoredSettingsNavigation).getByRole("button", {
        name: "录制",
      }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "录制" }),
    ).toBeVisible();
    expect(
      within(restoredSettingsNavigation).getByRole("button", {
        name: "录制",
      }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      document.querySelectorAll("[data-settings-section]:not([hidden])"),
    ).toHaveLength(1);
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

    let pane = await screen.findByRole("complementary", {
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
      await screen.findByRole("region", { name: "还没有消息" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "消息上下文面板" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "音频" }));
    pane = await screen.findByRole("complementary", {
      name: "音频上下文面板",
    });
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

  it("shares a runtime-only pane width across sections, collapse, and viewport clamps", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
      writable: true,
    });
    applicationApi({
      ...restored,
      navigation: { section: "library" },
      library: { phase: "ready", audioCount: 1 },
      activity: [
        {
          id: "resize-shared-width",
          kind: "startup_reconciliation_failed",
          safeSummary: "启动恢复暂未完成。",
          occurrenceCount: 1,
          unread: false,
          settingsTarget: null,
          lastOccurredAt: 2,
        },
      ],
      capture: { phase: "idle" },
    });
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    const view = render(createElement(App));

    let resizeHandle = await screen.findByRole("separator", {
      name: "调整音频上下文面板宽度",
    });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "300");
    expect(shellWidth()).toBe("350px");
    for (let step = 0; step < 18; step += 1) {
      fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    }
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "480");
    expect(shellWidth()).toBe("530px");
    expect(writes).not.toHaveBeenCalled();

    for (const target of [
      { navigation: /^互联$/, label: "互联" },
      { navigation: /^消息/, label: "消息" },
      { navigation: /^设置$/, label: "设置" },
      { navigation: /^音频$/, label: "音频" },
    ]) {
      await user.click(screen.getByRole("button", { name: target.navigation }));
      resizeHandle = await screen.findByRole("separator", {
        name: `调整${target.label}上下文面板宽度`,
      });
      expect(resizeHandle).toHaveAttribute("aria-valuenow", "480");
      expect(shellWidth()).toBe("530px");
    }
    expect(writes).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "收起音频上下文面板" }),
    );
    expect(
      screen.queryByRole("separator", { name: /上下文面板宽度/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "打开音频上下文面板" }),
    );
    expect(
      await screen.findByRole("separator", {
        name: "调整音频上下文面板宽度",
      }),
    ).toHaveAttribute("aria-valuenow", "480");
    expect(writes).toHaveBeenCalledTimes(2);
    expect(
      writes.mock.calls.every(
        ([key]) => key === "voice2text.shell.context-panes.v1",
      ),
    ).toBe(true);

    window.innerWidth = 880;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: /上下文面板宽度/ }),
      ).toHaveAttribute("aria-valuenow", "350"),
    );
    expect(shellWidth()).toBe("400px");
    window.innerWidth = 1280;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: /上下文面板宽度/ }),
      ).toHaveAttribute("aria-valuenow", "480"),
    );
    expect(shellWidth()).toBe("530px");

    view.unmount();
    render(createElement(App));
    expect(
      await screen.findByRole("separator", {
        name: "调整音频上下文面板宽度",
      }),
    ).toHaveAttribute("aria-valuenow", "300");
    expect(shellWidth()).toBe("350px");
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
            kind: "startup_reconciliation_failed",
            safeSummary: "启动恢复暂未完成。",
            occurrenceCount: 1,
            unread: true,
            settingsTarget: null,
            lastOccurredAt: 2,
          },
          {
            id: "failed",
            kind: "capture_runtime_unavailable",
            safeSummary: "录制组件暂不可用。",
            occurrenceCount: 2,
            unread: true,
            settingsTarget: "recording",
            lastOccurredAt: 1,
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
    await user.click(screen.getByRole("button", { name: /启动恢复暂未完成/ }));
    expect(
      screen.getByRole("complementary", { name: "消息上下文面板" }),
    ).toBeVisible();
    const messageDetails = screen.getByRole("region", { name: "消息详情" });
    expect(messageDetails).toHaveTextContent("需要处理");
    expect(within(messageDetails).queryByRole("button")).toBeNull();

    await user.click(screen.getByRole("button", { name: /录制组件暂不可用/ }));
    expect(
      document.querySelector('[aria-label="消息上下文面板"]'),
    ).not.toBeNull();
    expect(
      within(messageDetails).getByRole("button", { name: "前往录制设置" }),
    ).toBeVisible();
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
      description: "",
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

function shellWidth() {
  const wrapper = document.querySelector<HTMLElement>(
    '[data-slot="sidebar-wrapper"]',
  );
  if (!wrapper) throw new Error("Expected the sidebar wrapper");
  return wrapper.style.getPropertyValue("--sidebar-width");
}
