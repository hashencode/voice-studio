// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
import { SidebarProvider } from "../../../src/renderer/components/ui/sidebar";
import { ContextPaneShell } from "../../../src/renderer/features/shell/context-pane-shell";
import type {
  ApplicationSnapshot,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";
import { companionRendererStubs } from "../../fixtures/companion";

const readySnapshot: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 4,
  navigation: { section: "library" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
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
  let current = snapshot;
  const api: Voice2TextDesktopApi = {
    ...companionRendererStubs(),
    getAiSettings: vi.fn(async () => testAiSettings()),
    saveAiSettings: vi.fn(async () => testAiSettings()),
    replaceAiProviderSecret: vi.fn(async () => testAiSettings()),
    deleteAiProviderSecret: vi.fn(async () => testAiSettings()),
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
    getApplicationSnapshot: vi.fn(async () => current),
    navigate: vi.fn(async (section) => {
      current = {
        ...current,
        revision: current.revision + 1,
        navigation: { section },
      };
      return current;
    }),
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

function testAiSettings() {
  return {
    revision: 1,
    config: {
      providerId: "deepseek" as const,
      displayName: "DeepSeek",
      modelId: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      endpointOrigin: "https://api.deepseek.com",
      processingLocation: "cloudDirect" as const,
      requiresConsent: true as const,
    },
    secretState: "missing" as const,
    deviceSecurity: {
      kind: "device-security" as const,
      fileVaultState: "unknown" as const,
      applicationLayerEncryption: "not-claimed" as const,
    },
  };
}

describe("application shell", () => {
  it("keeps the context pane docked when the window width changes", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 320,
      writable: true,
    });
    installApi(readySnapshot);

    render(<App />);

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    expect(navigation).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toHaveAttribute("data-presentation", "docked");

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1240,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toHaveAttribute("data-presentation", "docked");

    const outer = navigation.closest<HTMLElement>(
      '[data-slot="sidebar-inner"]',
    )?.parentElement;
    expect(outer).toHaveAttribute("data-slot", "sidebar-container");
    expect(outer).toHaveClass("flex");
    expect(document.querySelector('[data-mobile="true"]')).toBeNull();
  });

  it("uses the official nested sidebar-09 shell geometry and landmarks", async () => {
    const api = installApi(readySnapshot);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "录制详情", level: 1 });

    const wrapper = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.getPropertyValue("--sidebar-width")).toBe("350px");

    const outer = wrapper!.querySelector<HTMLElement>(
      ':scope > [data-slot="sidebar"]',
    );
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(outer).toHaveAttribute("data-collapsible", "");

    const container = outer!.querySelector<HTMLElement>(
      ':scope > [data-slot="sidebar-container"]',
    );
    expect(container).toHaveAttribute("data-presentation", "docked");
    expect(container).toHaveClass("overflow-hidden");

    const inner = container!.querySelector<HTMLElement>(
      ':scope > [data-slot="sidebar-inner"]',
    );
    const nestedSidebars = inner!.querySelectorAll<HTMLElement>(
      ':scope > [data-slot="sidebar"]',
    );
    expect(nestedSidebars).toHaveLength(2);

    const navigation = screen.getByRole("navigation", {
      name: "工作站主导航",
    });
    expect(navigation).toBe(nestedSidebars[0]);
    expect(navigation).toHaveClass(
      "w-[calc(var(--sidebar-width-icon)+1px)]!",
      "border-r",
    );
    expect(
      within(navigation)
        .getByLabelText("Voice2Text")
        .closest('[data-slot="sidebar-header"]'),
    ).not.toBeNull();
    expect(
      within(navigation)
        .getByRole("button", { name: "设置" })
        .closest('[data-slot="sidebar-footer"]'),
    ).not.toBeNull();
    expect(
      within(navigation)
        .getByRole("button", { name: "音频" })
        .closest('[data-slot="sidebar-content"]'),
    ).not.toBeNull();
    expect(
      within(navigation)
        .getByRole("button", { name: "互联" })
        .closest('[data-slot="sidebar-content"]'),
    ).not.toBeNull();

    for (const label of ["音频", "互联", "设置"]) {
      const railAction = within(navigation).getByRole("button", {
        name: label,
      });
      expect(railAction).toHaveAttribute("data-slot", "sidebar-menu-button");
      expect(railAction).toHaveClass("h-8");
      expect(railAction).not.toHaveClass("size-10");
    }

    const insetHeader = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-inset"] > header',
    );
    expect(insetHeader).not.toBeNull();
    const pane = screen.getByRole("complementary", {
      name: "音频上下文面板",
    });
    const contextTrigger = within(pane).getByRole("button", {
      name: "收起音频上下文面板",
    });
    expect(contextTrigger).toHaveAttribute("data-sidebar", "trigger");
    expect(contextTrigger).toHaveClass("size-7");
    expect(
      contextTrigger.querySelector("svg.lucide-panel-left"),
    ).not.toBeNull();
    expect(contextTrigger).not.toHaveTextContent(/[‹›]/);

    expect(pane).toBe(nestedSidebars[1]);
    expect(pane).toHaveAttribute("data-presentation", "docked");
    expect(pane).toHaveClass(
      "w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]!",
      "shrink-0",
    );
    expect(pane).not.toHaveClass("flex-1");
    const fixedPaneHeader = pane.querySelector<HTMLElement>(
      "[data-context-pane-fixed-header]",
    );
    const scrollingPaneContent = pane.querySelector<HTMLElement>(
      "[data-context-pane-scrolling-content]",
    );
    const fixedPaneFooter = pane.querySelector<HTMLElement>(
      "[data-context-pane-fixed-footer]",
    );
    const headerControls = [
      within(pane).getByRole("heading", { name: "音频" }),
    ];
    const footerControls = [
      within(pane).getByRole("button", { name: "导入音频" }),
    ];
    for (const control of headerControls) {
      expect(fixedPaneHeader).toContainElement(control);
    }
    for (const control of footerControls) {
      expect(fixedPaneFooter).toContainElement(control);
    }
    expect(
      fixedPaneHeader?.compareDocumentPosition(scrollingPaneContent!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      scrollingPaneContent?.compareDocumentPosition(fixedPaneFooter!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(scrollingPaneContent).toContainElement(
      within(pane).getByRole("searchbox", { name: "搜索音频" }),
    );
    expect(insetHeader).not.toContainElement(contextTrigger);
    expect(fixedPaneHeader).toHaveClass("min-h-[58px]", "flex-col");
    expect(insetHeader).toHaveClass("min-h-[58px]");
    expect(insetHeader).not.toHaveAttribute("style");
    const paneTitleRow = within(pane).getByRole("heading", {
      name: "音频",
    }).parentElement;
    const paneActions = within(pane).getByRole("group", { name: "音频操作" });
    expect(paneTitleRow).not.toContainElement(paneActions);
    expect(fixedPaneFooter).toContainElement(paneActions);

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!).toHaveAttribute("data-slot", "sidebar-inset");
    expect(mains[0]).toHaveClass(
      "z-30",
      "transition-[margin]",
      "duration-200",
      "ease-linear",
    );
    expect(document.querySelector('[data-slot="sidebar-gap"]')).toHaveClass(
      "transition-[width]",
      "duration-200",
      "ease-linear",
    );
    expect(
      document.querySelector('[data-slot="sidebar-container"]'),
    ).toHaveClass(
      "transition-[left,right,width]",
      "duration-200",
      "ease-linear",
    );
    expect(document.getElementById("main-content")?.tagName).toBe("DIV");
    expect(mains[0]!.querySelector("header")).toHaveClass(
      "sticky",
      "top-0",
      "border-b",
      "bg-background",
    );

    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(
      inner!.querySelectorAll(':scope > [data-slot="sidebar"]'),
    ).toHaveLength(2);
    expect(
      screen.getByRole("complementary", { name: "设置上下文面板" }),
    ).toBeVisible();
  });

  it("does not expose the Sidebar cookie or Meta/Ctrl+B state authority", async () => {
    installApi(readySnapshot);
    render(<App />);
    const pane = await screen.findByRole("complementary", {
      name: "音频上下文面板",
    });
    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(pane).toBeVisible();
    expect(document.cookie).not.toContain("sidebar_state=");
  });

  it("restores recording in the content area without global header controls", async () => {
    const api = installApi(readySnapshot);
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("status", { name: "正在加载工作台" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "录制详情", level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText("还没有音频")).toBeVisible();
    expect(screen.queryByText(/旧版资料库/)).not.toBeInTheDocument();

    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    const audio = within(navigation).getByRole("button", { name: "音频" });
    expect(audio).toHaveAttribute("aria-current", "page");
    expect(audio.querySelector("svg.lucide-audio-lines")).not.toBeNull();
    expect(within(navigation).getAllByRole("button")).toHaveLength(4);
    const message = within(navigation).getByRole("button", { name: "消息" });
    const settings = within(navigation).getByRole("button", { name: "设置" });
    expect(
      message.compareDocumentPosition(settings) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(navigation).queryByRole("button", { name: "转写任务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toHaveAttribute("data-presentation", "docked");

    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "正在录音" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "录制详情" })).toHaveTextContent(
      "产品周会",
    );
    expect(
      screen.queryByRole("region", { name: "录制准备" }),
    ).not.toBeInTheDocument();
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
  });

  it("hides the third-column header whenever no audio is selected", async () => {
    installApi({ ...readySnapshot, capture: { phase: "idle" } });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("还没有音频")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "请选择音频", level: 1 }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "录制准备" })).toHaveClass(
      "flex-1",
      "justify-center",
    );
    const pane = screen.getByRole("complementary", {
      name: "音频上下文面板",
    });

    await user.click(
      screen.getByRole("button", { name: "收起音频上下文面板" }),
    );
    expect(pane).toBeInTheDocument();
    expect(pane).toHaveAttribute("aria-hidden", "true");
    const reopen = screen.getByRole("button", {
      name: "打开音频上下文面板",
    });
    expect(reopen).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "请选择音频", level: 1 }),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector<HTMLElement>(
        '[data-slot="sidebar-inset"] > header',
      ),
    ).toBeNull();
    expect(reopen).toHaveFocus();
    await user.click(reopen);
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
  });

  it("opens a selected audio from recording setup after the back action is removed", async () => {
    const summary = {
      audioId: 12,
      displayName: "已有录音.wav",
      durationMs: 1_000,
      createdAtMs: 1,
      processingState: "completed" as const,
      generationId: null,
      generationKind: null,
      segmentCount: 0,
    };
    installApi(
      {
        ...readySnapshot,
        capture: {
          phase: "failed",
          sessionId: "capture-failed-12",
          title: "失败的录制",
          elapsedMs: 1_000,
        },
      },
      {
        listAudios: vi.fn(async () => [summary]),
        openAudio: vi.fn(async () => ({
          revision: 1,
          summary,
          segments: [],
          speakers: [],
          canUndo: false,
          canRedo: false,
        })),
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "dual_track" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "granted" as const,
          microphones: [
            { id: "mic-default", name: "默认麦克风", isDefault: true },
          ],
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: [],
        })),
      },
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "打开 已有录音.wav" }),
    );
    const newRecording = await screen.findByRole("button", { name: "新录音" });
    await waitFor(() => expect(newRecording).toBeEnabled());
    await user.click(newRecording);
    expect(
      await screen.findByRole("heading", { name: "设置音频录制" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "打开 已有录音.wav" }));

    expect(
      await screen.findByRole("heading", { name: "已有录音.wav", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "录制详情" }),
    ).not.toBeInTheDocument();
  });

  it("keeps independent first-use pane preferences including settings", async () => {
    const api = installApi(readySnapshot);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<App />);

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    expect(writes).not.toHaveBeenCalled();

    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.getByRole("complementary", { name: "设置上下文面板" }),
    ).toBeVisible();
    expect(writes).not.toHaveBeenCalled();

    await user.click(within(navigation).getByRole("button", { name: "互联" }));
    expect(
      await screen.findByRole("complementary", { name: "互联上下文面板" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "收起互联上下文面板" }),
    );
    expect(writes).toHaveBeenCalledTimes(1);

    await user.click(within(navigation).getByRole("button", { name: "音频" }));
    expect(
      await screen.findByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    expect(writes).toHaveBeenCalledTimes(1);

    await user.click(within(navigation).getByRole("button", { name: "互联" }));
    expect(
      screen.queryByRole("complementary", { name: "互联上下文面板" }),
    ).not.toBeInTheDocument();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("restores persisted pane preferences independently", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ audio: "closed", companion: "open" }),
    );
    const api = installApi(readySnapshot);
    const user = userEvent.setup();
    render(<App />);

    const openAudioPane = await screen.findByRole("button", {
      name: "打开音频上下文面板",
    });
    expect(openAudioPane).toBeVisible();
    expect(
      document.querySelector<HTMLElement>(
        '[data-slot="sidebar-inset"] > header',
      ),
    ).toContainElement(openAudioPane);
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "互联" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("companion"));
    expect(
      screen.getByRole("complementary", { name: "互联上下文面板" }),
    ).toBeVisible();
  });

  it("restores a collapsed message pane preference", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ messages: "closed" }),
    );
    installApi({ ...readySnapshot, capture: { phase: "idle" } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "消息" }));
    expect(
      screen.queryByRole("complementary", { name: "消息上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开消息上下文面板" }),
    ).toBeVisible();
  });

  it("does not treat context-pane child controls as dismissal", async () => {
    const onRequestClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SidebarProvider persistState={false} enableKeyboardShortcut={false}>
        <ContextPaneShell
          open
          section="audio"
          presentation="overlay"
          onRequestClose={onRequestClose}
          header={
            <>
              <input type="search" aria-label="搜索音频" />
              <button type="button">开始录音</button>
            </>
          }
        >
          <button type="button">选择音频 A</button>
        </ContextPaneShell>
      </SidebarProvider>,
    );

    await user.click(screen.getByRole("button", { name: "选择音频 A" }));
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    const pane = screen.getByRole("complementary", {
      name: "音频上下文面板",
    });
    const fixedHeader = pane.querySelector("[data-context-pane-fixed-header]");
    const scrollingContent = pane.querySelector(
      "[data-context-pane-scrolling-content]",
    );
    expect(fixedHeader).toContainElement(
      screen.getByRole("heading", { name: "音频" }),
    );
    expect(fixedHeader).toContainElement(
      screen.getByRole("searchbox", { name: "搜索音频" }),
    );
    expect(fixedHeader).toContainElement(
      screen.getByRole("button", { name: "开始录音" }),
    );
    expect(scrollingContent).toContainElement(
      screen.getByRole("button", { name: "选择音频 A" }),
    );
    expect(fixedHeader?.compareDocumentPosition(scrollingContent!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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
    expect(screen.getByRole("button", { name: "导入音频" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试初始化" }));
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("retry");
    await user.click(screen.getByRole("button", { name: "查看修复建议" }));
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("repair-guidance");
  });

  it("loads Audio only after a blocked profile becomes ready", async () => {
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
    const ready: ApplicationSnapshot = {
      ...readySnapshot,
      revision: blocked.revision + 1,
      capture: { phase: "idle" },
    };
    const listAudios = vi.fn(async () => []);
    const requestBootstrapAction = vi.fn(async () => ready);
    installApi(blocked, { listAudios, requestBootstrapAction });
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("可用空间不足");
    expect(listAudios).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "重试初始化" }));

    expect(await screen.findByText("还没有音频")).toBeVisible();
    expect(listAudios).toHaveBeenCalledTimes(1);
  });

  it("renders route-local Audio loading and recoverable error states", async () => {
    const pending = new Promise<never>(() => undefined);
    const first = installApi(
      { ...readySnapshot, capture: { phase: "idle" } },
      { listAudios: vi.fn(() => pending) },
    );
    const view = render(<App />);
    expect(
      await screen.findByRole("status", { name: "正在载入音频列表" }),
    ).toBeVisible();
    view.unmount();

    first.listAudios = vi.fn(async () => {
      throw new Error("读取失败");
    });
    Object.defineProperty(window, "voice2text", {
      configurable: true,
      value: first,
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.getByRole("button", { name: "重新载入" })).toBeEnabled();
  });

  it("announces offline and unavailable capability without color-only meaning", async () => {
    const api = installApi({
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
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("library"));
    expect(screen.getByRole("button", { name: "音频" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps reconciliation out of global activity and does not auto-retry", async () => {
    const api = installApi(
      {
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
      },
      {
        listProcessingTasks: vi.fn(
          async () =>
            [
              {
                id: 41,
                audioId: 9,
                displayName: "中断的周会.wav",
                state: "interrupted",
                phase: "asr",
                progressFraction: 0.4,
                attempt: 2,
                errorCode: "PROCESS_INTERRUPTED",
              },
            ] satisfies ProcessingTask[],
        ),
        listAudios: vi.fn(async () => [
          {
            audioId: 9,
            displayName: "中断的音频.wav",
            durationMs: 1_000,
            createdAtMs: 1,
            processingState: "interrupted" as const,
            generationId: null,
            generationKind: null,
            segmentCount: 0,
          },
        ]),
        openAudio: vi.fn(async () => ({
          revision: 1,
          summary: {
            audioId: 9,
            displayName: "中断的音频.wav",
            durationMs: 1_000,
            createdAtMs: 1,
            processingState: "interrupted" as const,
            generationId: null,
            generationKind: null,
            segmentCount: 0,
          },
          segments: [],
          speakers: [],
          canUndo: false,
          canRedo: false,
        })),
      },
    );
    const user = userEvent.setup();
    render(<App />);
    expect(
      screen.queryByRole("heading", { name: "启动恢复需要确认" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "消息" }));
    expect(
      screen.getByRole("complementary", { name: "消息上下文面板" }),
    ).toHaveTextContent("暂无消息");
    expect(
      screen.getByRole("heading", { name: "消息", level: 1 }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    expect(api.navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "音频" }));
    await user.click(
      await screen.findByRole("button", { name: /打开 中断的音频/ }),
    );
    expect(
      await screen.findByRole("button", { name: "重试 中断的周会.wav" }),
    ).toBeEnabled();
    expect(api.retryProcessing).not.toHaveBeenCalled();
  });

  it("keeps transfer reconciliation out of global activity", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ audio: "open", companion: "closed", settings: "open" }),
    );
    const api = installApi({
      ...readySnapshot,
      navigation: { section: "settings" },
      capture: { phase: "idle" },
      reconciliation: [
        {
          kind: "transfer",
          identity: "transfer-recovery-1",
          state: "interrupted",
          requiresExplicitAction: true,
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "消息" }));
    expect(
      screen.getByRole("complementary", { name: "消息上下文面板" }),
    ).toHaveTextContent("暂无消息");
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("keeps a narrow settings pane open after selection", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 880,
      writable: true,
    });
    const api = installApi({
      ...readySnapshot,
      navigation: { section: "settings" },
      capture: { phase: "idle" },
    });
    const user = userEvent.setup();
    render(<App />);

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    await user.click(screen.getByRole("button", { name: "音频智能" }));
    expect(
      screen.getByRole("complementary", { name: "设置上下文面板" }),
    ).toBeVisible();

    await user.click(within(navigation).getByRole("button", { name: "音频" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("library"));
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      await screen.findByRole("complementary", { name: "设置上下文面板" }),
    ).toBeVisible();
  });

  it("opens the exact capture recovery from a message and exposes its action", async () => {
    const targetedRecovery = {
      sessionId: "session-target-recovery-1234",
      state: "recoverable" as const,
      captureMode: "dual_track" as const,
      captureTimelineMs: 12_000,
      systemAudioHealthy: true,
      microphoneHealthy: true,
      partialCapture: false,
      finalizedChunkCount: 2,
      eventCount: 3,
      gapCount: 0,
      interruptionReason: null,
      recordingSha256: null,
    };
    const otherRecovery = {
      ...targetedRecovery,
      sessionId: "session-other-recovery-12345",
      captureTimelineMs: 4_000,
    };
    const actOnCaptureRecovery = vi.fn(async () => null);
    installApi(
      {
        ...readySnapshot,
        capture: { phase: "idle" },
        activity: [
          {
            id: "capture:failed:target",
            kind: "capture_failed",
            captureSessionId: targetedRecovery.sessionId,
            createdAt: 100,
            title: "录制中断，需要处理",
            severity: "warning",
            read: false,
            resolved: false,
            detailTarget: "capture-details",
          },
        ],
      },
      {
        listCaptureRecoveries: vi.fn(async () => [
          otherRecovery,
          targetedRecovery,
        ]),
        actOnCaptureRecovery,
      },
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "消息，1 条未读" }),
    );
    await user.click(
      screen.getByRole("button", { name: /录制中断，需要处理/ }),
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "录制中断，需要处理" }),
      ).getByRole("button", { name: "打开录制详情" }),
    );

    expect(
      await screen.findByRole("heading", { name: "录制详情", level: 1 }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "录制详情" })).toBeVisible();
    await user.click(
      screen.getAllByRole("button", { name: "保留并完成恢复" })[0]!,
    );
    expect(actOnCaptureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: targetedRecovery.sessionId,
        action: "keep",
      }),
    );
  });

  it("does not expose profile migration copy in the user interface", async () => {
    const applicationDataRoot = "/private/secret/application-data";
    installApi({
      ...readySnapshot,
      profile: { phase: "ready", legacyDatabaseArchived: true },
      capture: { phase: "idle" },
    });
    render(<App />);

    await screen.findByRole("navigation", { name: "工作站主导航" });
    expect(screen.queryByText(/已归档旧版资料库/)).not.toBeInTheDocument();
    expect(screen.queryByText(/全新 Audio 资料库/)).not.toBeInTheDocument();
    expect(screen.queryByText(applicationDataRoot)).not.toBeInTheDocument();
  });
});
