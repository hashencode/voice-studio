// @vitest-environment jsdom

import * as React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
import { SidebarProvider } from "../../../src/renderer/components/ui/sidebar";
import { ContextPaneShell } from "../../../src/renderer/features/shell/context-pane-shell";
import { AppShellFrame } from "../../../src/renderer/features/shell/app-shell-frame";
import type {
  ApplicationSnapshot,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";
import {
  companionRendererStubs,
  localModelSnapshot,
} from "../../fixtures/companion";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe("render-backed shell frame", () => {
  it("installs exactly one root toast host", () => {
    installApi(readySnapshot);

    render(<App />);

    expect(
      document.querySelectorAll('section[aria-label^="Notifications"]'),
    ).toHaveLength(1);
  });

  it("owns source-order slots without feature controllers", () => {
    const { container } = render(
      <AppShellFrame
        section="audio"
        onNavigate={vi.fn()}
        unreadActivityCount={0}
        contextPane={{
          open: true,
          section: "audio",
          presentation: "docked",
          onRequestClose: vi.fn(),
          head: <button type="button">新录音</button>,
          search: <input type="search" aria-label="搜索夹具" />,
          filters: <button type="button">全部 3</button>,
          footer: <span>列表页脚</span>,
          children: <button type="button">夹具音频</button>,
        }}
        contextPaneWidth={300}
        contextPaneResize={{
          minimum: 240,
          maximum: 480,
          onChange: vi.fn(),
        }}
        onTogglePane={vi.fn()}
        title="夹具标题"
        history={{
          canGoBack: false,
          canGoForward: false,
          onBack: vi.fn(),
          onForward: vi.fn(),
        }}
        actions={<button type="button">页面操作</button>}
        notice={<span>状态提示</span>}
      >
        <p>内容夹具</p>
      </AppShellFrame>,
    );

    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]')!;
    expect(
      Array.from(wrapper.children).map((child) =>
        child.getAttribute("data-slot"),
      ),
    ).toEqual([
      "sidebar",
      "pane-resize-handle",
      "sidebar-rail",
      "sidebar-inset",
    ]);
    const sidebarInner = wrapper.querySelector('[data-slot="sidebar-inner"]')!;
    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    const context = screen.getByRole("complementary", {
      name: "音频上下文面板",
    });
    expect(Array.from(sidebarInner.children)).toEqual([navigation, context]);
    expect(
      Array.from(context.children).map((child) =>
        child.getAttribute("data-shell-slot"),
      ),
    ).toEqual([
      "context-head",
      "context-search",
      "context-filters",
      "context-list",
      "context-footer",
    ]);
    const main = screen.getByRole("main");
    expect(
      Array.from(main.children).map((child) =>
        child.getAttribute("data-shell-slot"),
      ),
    ).toEqual(["content-head", "content-notice", "content"]);
    expect(
      main.querySelector('[data-shell-slot="page-actions"]'),
    ).toContainElement(screen.getByRole("button", { name: "页面操作" }));
    expect(main.querySelector('[data-shell-slot="content"]')).toContainElement(
      screen.getByText("内容夹具"),
    );
    expect(main.querySelector('[data-shell-slot="content-head"]')).toHaveClass(
      "px-4",
      "gap-1.5",
    );
    expect(screen.queryByRole("button", { name: "前进" })).toBeNull();
    expect(
      main.querySelector(
        '[data-shell-slot="content-head"] [data-slot="separator"]',
      ),
    ).toHaveClass("mx-2");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass(
      "min-w-0",
      "flex-1",
      "font-semibold",
      "leading-snug",
    );
    expect(wrapper).toHaveStyle({
      "--sidebar-width": "350px",
      "--sidebar-width-icon": "48px",
    });
    expect(
      screen.getByRole("button", { name: "收起音频上下文面板" }),
    ).toHaveAttribute("data-variant", "handle");
    expect(
      screen.getByRole("separator", {
        name: "调整音频上下文面板宽度",
      }),
    ).toHaveStyle({ left: "var(--sidebar-width)" });
    expect(context).toHaveClass(
      "w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-2px)]!",
    );
    expect(
      context.querySelector('[data-shell-slot="context-filters"]'),
    ).toHaveClass("h-[37px]");
    // The public render uses a 48px collapsed prefix, not the previous +1px overlay gap.
    expect(wrapper.querySelector('[data-slot="sidebar-gap"]')).not.toHaveClass(
      "!w-[calc(var(--sidebar-width-icon)+1px)]",
    );
    expect(main).not.toHaveClass(
      "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]",
    );
  });

  it("replaces the default title and composes a fixed single-row footer outside the scroll owner", () => {
    const contentRef = React.createRef<HTMLDivElement>();
    const { container } = render(
      <AppShellFrame
        section="audio"
        onNavigate={vi.fn()}
        unreadActivityCount={0}
        contextPane={null}
        contextPaneWidth={300}
        onTogglePane={vi.fn()}
        title="录制详情"
        customTitle={<input aria-label="录音名称" defaultValue="产品周会" />}
        footer={<div data-testid="capture-controls">录制中 00:01:12</div>}
        contentRef={contentRef}
        history={{
          canGoBack: true,
          canGoForward: false,
          onBack: vi.fn(),
          onForward: vi.fn(),
        }}
      >
        <p>实时字幕</p>
      </AppShellFrame>,
    );

    expect(
      screen.queryByRole("heading", { level: 1, name: "录制详情" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "录音名称" })).toBeVisible();

    const main = screen.getByRole("main");
    const header = main.querySelector('[data-shell-slot="content-head"]');
    const content = main.querySelector('[data-shell-slot="content"]');
    const footer = main.querySelector('[data-shell-slot="content-footer"]');
    expect(Array.from(main.children)).toEqual([header, content, footer]);
    expect(header).toHaveClass(
      "h-[50px]",
      "shrink-0",
      "border-b",
      "bg-background",
    );
    expect(header).not.toHaveClass("sticky");
    expect(content).toHaveClass("min-h-0", "flex-1", "overflow-auto");
    expect(contentRef.current).toBe(content);
    expect(content).not.toContainElement(
      screen.getByTestId("capture-controls"),
    );
    expect(footer).toContainElement(screen.getByTestId("capture-controls"));
    expect(footer).toHaveClass(
      "flex",
      "shrink-0",
      "flex-nowrap",
      "items-center",
      "border-t",
      "bg-background",
    );
    expect(footer).not.toHaveClass(
      "flex-wrap",
      "hidden",
      "shadow",
      "sm:hidden",
      "md:hidden",
    );
    expect(footer?.className).not.toMatch(/(?:sm|md|lg):/);
    expect(
      container.querySelectorAll('[data-shell-slot="content-footer"]'),
    ).toHaveLength(1);
  });

  it("suppresses pane transitions only while the primary section changes", () => {
    const transitionsAtLayout: string[][] = [];
    const layoutRead = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        const container = this.parentElement?.querySelector<HTMLElement>(
          '[data-slot="sidebar-container"]',
        );
        transitionsAtLayout.push([
          this.style.transition,
          container?.style.transition ?? "",
        ]);
        return 0;
      });

    const frame = (section: "audio" | "settings", open: boolean) => (
      <AppShellFrame
        section={section}
        onNavigate={vi.fn()}
        unreadActivityCount={0}
        contextPane={{
          open,
          section,
          presentation: "docked",
          onRequestClose: vi.fn(),
          children: <span>{section} pane</span>,
        }}
        contextPaneWidth={300}
        onTogglePane={vi.fn()}
        title={`${section} page`}
        history={{
          canGoBack: false,
          canGoForward: false,
          onBack: vi.fn(),
          onForward: vi.fn(),
        }}
      >
        {section} content
      </AppShellFrame>
    );

    const view = render(frame("audio", true));
    const gap = () => view.container.querySelector('[data-slot="sidebar-gap"]');
    const container = () =>
      view.container.querySelector('[data-slot="sidebar-container"]');
    expect(gap()).not.toHaveClass("transition-none");
    expect(container()).not.toHaveClass("transition-none");
    expect(layoutRead).not.toHaveBeenCalled();

    view.rerender(frame("settings", false));
    expect(layoutRead).toHaveBeenCalledOnce();
    expect(transitionsAtLayout).toEqual([["none", "none"]]);
    expect((gap() as HTMLElement).style.transition).toBe("");
    expect((container() as HTMLElement).style.transition).toBe("");
    expect(gap()).toHaveClass("transition-[width]", "duration-200");
    expect(container()).toHaveClass(
      "transition-[left,right,width]",
      "duration-200",
    );

    view.rerender(frame("audio", true));
    expect(layoutRead).toHaveBeenCalledTimes(2);
    expect(transitionsAtLayout).toEqual([
      ["none", "none"],
      ["none", "none"],
    ]);
    expect((gap() as HTMLElement).style.transition).toBe("");
    expect((container() as HTMLElement).style.transition).toBe("");
    expect(gap()).toHaveClass("transition-[width]", "duration-200");
    expect(container()).toHaveClass(
      "transition-[left,right,width]",
      "duration-200",
    );

    view.rerender(frame("audio", false));
    expect(layoutRead).toHaveBeenCalledTimes(2);
    expect(gap()).toHaveClass("transition-[width]", "duration-200");
    expect(container()).toHaveClass(
      "transition-[left,right,width]",
      "duration-200",
    );

    view.rerender(frame("audio", true));
    expect(layoutRead).toHaveBeenCalledTimes(2);
    expect(gap()).toHaveClass("transition-[width]", "duration-200");
    expect(container()).toHaveClass(
      "transition-[left,right,width]",
      "duration-200",
    );
  });

  it("keeps controlled pane contents mounted and omits empty optional bands", async () => {
    const onTogglePane = vi.fn();
    const onRequestClose = vi.fn();
    const onBack = vi.fn();
    const titleRef = React.createRef<HTMLHeadingElement>();
    const paneTriggerRef = React.createRef<HTMLButtonElement>();
    const contentRef = React.createRef<HTMLDivElement>();
    const frame = (open: boolean) => (
      <AppShellFrame
        section="settings"
        onNavigate={vi.fn()}
        unreadActivityCount={0}
        contextPane={{
          open,
          section: "settings",
          presentation: "docked",
          onRequestClose,
          children: <input aria-label="持久输入" defaultValue="初始值" />,
        }}
        contextPaneWidth={300}
        contextPaneResize={{
          minimum: 240,
          maximum: 480,
          onChange: vi.fn(),
        }}
        onTogglePane={onTogglePane}
        paneTriggerRef={paneTriggerRef}
        title="设置夹具"
        titleRef={titleRef}
        contentRef={contentRef}
        history={{
          canGoBack: true,
          canGoForward: false,
          onBack,
          onForward: vi.fn(),
        }}
      >
        内容夹具
      </AppShellFrame>
    );
    const view = render(frame(true));
    const input = screen.getByRole("textbox", { name: "持久输入" });
    expect(
      screen.getByRole("separator", {
        name: "调整设置上下文面板宽度",
      }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "保留值" } });
    for (const slot of [
      "context-search",
      "context-filters",
      "context-footer",
      "page-actions",
      "content-notice",
    ]) {
      expect(
        view.container.querySelector(`[data-shell-slot="${slot}"]`),
      ).toBeNull();
    }
    await userEvent.setup().click(screen.getByRole("button", { name: "后退" }));
    expect(onBack).toHaveBeenCalledOnce();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "收起设置上下文面板" }));
    expect(onTogglePane).toHaveBeenCalledOnce();
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    view.rerender(frame(false));
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    const pane = input.closest('[role="complementary"]');
    expect(pane).toHaveClass("bg-background", "text-foreground");
    expect(pane).toHaveAttribute("inert");
    expect(pane).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveValue("保留值");
    expect(paneTriggerRef.current).toHaveStyle({
      left: "var(--sidebar-width-icon)",
    });
    paneTriggerRef.current?.focus();
    expect(paneTriggerRef.current).toHaveFocus();
    view.rerender(frame(true));
    expect(screen.getByRole("separator")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "持久输入" })).toBe(input);
    expect(pane).not.toHaveAttribute("inert");
    expect(titleRef.current).toBe(screen.getByRole("heading", { level: 1 }));
    expect(contentRef.current).toBe(document.getElementById("main-content"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });
});

const readySnapshot: ApplicationSnapshot = {
  protocolVersion: 3,
  revision: 4,
  navigation: { section: "library" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: { phase: "idle" },
};

const recordingSnapshot: ApplicationSnapshot = {
  ...readySnapshot,
  capture: {
    phase: "recording",
    sessionId: "capture-7",
    title: "产品周会",
    elapsedMs: 72_000,
  },
};

const shellAudio = {
  audioId: 1,
  displayName: "音频 A.wav",
  durationMs: 1_000,
  createdAtMs: 1,
  processingState: "completed" as const,
  generationId: null,
  generationKind: null,
  segmentCount: 0,
};

function shellWorkspace(audio: typeof shellAudio) {
  return {
    revision: 1,
    summary: audio,
    segments: [],
    speakers: [],
    canUndo: false,
    canRedo: false,
  };
}

const shellCapturePreflight = {
  minimumMacosVersion: "13.0",
  systemAudioMinimumMacosVersion: "13.0",
  captureMode: "dual_track" as const,
  systemAudioPermission: "granted" as const,
  microphonePermission: "granted" as const,
  microphones: [{ id: "mic-default", name: "MacBook 麦克风", isDefault: true }],
  availableBytes: 8 * 1024 ** 3,
  requiredBytes: 2 * 1024 ** 3,
  captionModelAvailable: true,
  canStart: true,
  blockingReasons: [],
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
    markActivityRead: vi.fn(async () => current),
    markAllActivityRead: vi.fn(async () => current),
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
    listAudios: vi.fn(async () => [shellAudio]),
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
    preflightCapture: vi.fn(async () => shellCapturePreflight),
    getFloatingCapturePreference: vi.fn(async () => ({ enabled: false })),
    setFloatingCapturePreference: vi.fn(async (enabled) => ({ enabled })),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    suggestCaptureTitle: vi.fn(async () => ({ title: "新录音2026090501" })),
    renameCaptureSession: vi.fn(async () => current),
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

describe("application shell", () => {
  it("keeps back history branchable and isolated by module", async () => {
    const audioB = { ...shellAudio, audioId: 2, displayName: "音频 B.wav" };
    const audioC = { ...shellAudio, audioId: 3, displayName: "音频 C.wav" };
    installApi(
      { ...readySnapshot, capture: { phase: "idle" } },
      {
        listAudios: vi.fn(async () => [shellAudio, audioB, audioC]),
        openAudio: vi.fn(async (audioId) => {
          const audio = [shellAudio, audioB, audioC].find(
            (candidate) => candidate.audioId === audioId,
          );
          return audio ? shellWorkspace(audio) : null;
        }),
      },
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "打开 音频 A.wav" }),
    );
    await user.click(screen.getByRole("button", { name: "打开 音频 B.wav" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "音频 B.wav" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "后退" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "音频 A.wav" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "前进" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开 音频 C.wav" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "音频 C.wav" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "前进" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(await screen.findByRole("button", { name: "云端模型" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "云端模型" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "音频" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "音频 C.wav" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "后退" })).toBeEnabled();
  });
  it("keeps raw load failures out of the shell error surface", async () => {
    installApi(readySnapshot, {
      getApplicationSnapshot: vi.fn(async () => {
        throw new Error("raw /private/application-state failure");
      }),
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "无法载入工作台" }),
    ).toBeVisible();
    expect(screen.getByText("请重新打开应用。")).toBeVisible();
    expect(screen.queryByText(/private\/application-state/)).toBeNull();
    expect(screen.getByRole("button", { name: "重新载入" })).toBeEnabled();
  });

  it("reloads the failed shell through one bootstrap request and can retry", async () => {
    const firstReload = deferred<ApplicationSnapshot>();
    const secondReload = deferred<ApplicationSnapshot>();
    const requestBootstrapAction = vi
      .fn<Voice2TextDesktopApi["requestBootstrapAction"]>()
      .mockImplementationOnce(() => firstReload.promise)
      .mockImplementationOnce(() => secondReload.promise);
    const onApplicationSnapshot = vi.fn(() => () => undefined);
    const api = installApi(readySnapshot, {
      getApplicationSnapshot: vi.fn(async () => {
        throw new Error("initial load failed");
      }),
      requestBootstrapAction,
      onApplicationSnapshot,
    });
    window.history.replaceState(null, "", "/#/settings");
    render(<App />);

    const reload = await screen.findByRole("button", { name: "重新载入" });
    fireEvent.click(reload);
    fireEvent.click(reload);

    expect(api.requestBootstrapAction).toHaveBeenCalledTimes(1);
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("recheck");
    expect(screen.getByRole("button", { name: "正在重新载入" })).toBeDisabled();

    await act(async () => firstReload.reject(new Error("reload failed")));
    expect(screen.getByText("无法重新载入，请重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新载入" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
    await act(async () => secondReload.resolve(readySnapshot));

    expect(
      await screen.findByRole("navigation", { name: "工作站主导航" }),
    ).toBeVisible();
    expect(api.requestBootstrapAction).toHaveBeenCalledTimes(2);
    expect(api.navigate).toHaveBeenCalledTimes(1);
    expect(api.navigate).toHaveBeenCalledWith("settings");
    expect(onApplicationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("routes a successful shell reload to the existing profile blocker", async () => {
    const blocked: ApplicationSnapshot = {
      ...readySnapshot,
      revision: readySnapshot.revision + 1,
      profile: {
        phase: "blocked",
        code: "filesystem_unavailable",
        message: "raw path detail",
        repairable: true,
      },
    };
    installApi(readySnapshot, {
      getApplicationSnapshot: vi.fn(async () => {
        throw new Error("initial load failed");
      }),
      requestBootstrapAction: vi.fn(async () => blocked),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "重新载入" }));

    expect(
      await screen.findByRole("dialog", { name: "本机资料库暂不可用" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "无法载入工作台" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a newer subscription snapshot when a reload fails late", async () => {
    const reload = deferred<ApplicationSnapshot>();
    let publish: ((snapshot: ApplicationSnapshot) => void) | undefined;
    installApi(readySnapshot, {
      getApplicationSnapshot: vi.fn(async () => {
        throw new Error("initial load failed");
      }),
      requestBootstrapAction: vi.fn(() => reload.promise),
      onApplicationSnapshot: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "重新载入" }));
    act(() => publish?.({ ...readySnapshot, revision: 10 }));
    await act(async () => reload.reject(new Error("late reload failure")));

    expect(
      await screen.findByRole("navigation", { name: "工作站主导航" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "无法载入工作台" }),
    ).not.toBeInTheDocument();
  });

  it("does not classify initial deep-link navigation failure as shell load failure", async () => {
    window.history.replaceState(null, "", "/#/settings");
    const api = installApi(readySnapshot, {
      navigate: vi.fn(async () => {
        throw new Error("deep-link navigation failed");
      }),
    });
    render(<App />);

    expect(
      await screen.findByRole("navigation", { name: "工作站主导航" }),
    ).toBeVisible();
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.queryByRole("heading", { name: "无法载入工作台" }),
    ).not.toBeInTheDocument();
  });

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
      await screen.findByRole("complementary", { name: "音频上下文面板" }),
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

  it("selects the local models settings panel from the initial route", async () => {
    window.history.replaceState(null, "", "/#/settings/local-models");
    installApi({
      ...readySnapshot,
      navigation: { section: "settings" },
      capture: { phase: "idle" },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "本地模型", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "本地模型", level: 2 }),
    ).not.toBeInTheDocument();

    const settingsPane = screen.getByRole("complementary", {
      name: "设置上下文面板",
    });
    expect(
      within(settingsPane).getByRole("button", { name: "本地模型" }),
    ).toHaveAttribute("aria-current", "location");

    const settingsSections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-settings-section]"),
    );
    expect(settingsSections.filter((section) => !section.hidden)).toHaveLength(
      1,
    );
    expect(
      document.querySelector('[data-settings-section="general"]'),
    ).toHaveAttribute("hidden");
    expect(
      screen.queryByRole("heading", { name: "通用", level: 2 }),
    ).not.toBeInTheDocument();
  });

  it("uses the render-backed nested shell geometry and landmarks", async () => {
    const getLocalModelSnapshot = vi.fn(async () => localModelSnapshot);
    const onLocalModelSnapshot = vi.fn(() => () => undefined);
    const api = installApi(
      { ...readySnapshot, capture: { phase: "idle" } },
      { getLocalModelSnapshot, onLocalModelSnapshot },
    );
    const getFloatingCapturePreference = vi.mocked(
      api.getFloatingCapturePreference!,
    );
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "请选择音频", level: 1 });

    const wrapper = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.getPropertyValue("--sidebar-width")).toBe("350px");
    const resizeHandle = screen.getByRole("separator", {
      name: "调整音频上下文面板宽度",
    });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    await waitFor(() =>
      expect(wrapper!.style.getPropertyValue("--sidebar-width")).toBe("360px"),
    );
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "310");

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
    expect(
      within(navigation)
        .getByRole("button", { name: "互联" })
        .querySelector("svg.lucide-send-horizontal"),
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
    const contextTrigger = screen.getByRole("button", {
      name: "收起音频上下文面板",
    });
    expect(contextTrigger).toHaveAttribute("data-sidebar", "rail");
    expect(contextTrigger).toHaveClass("h-12", "w-7");
    expect(pane).not.toContainElement(contextTrigger);

    expect(pane).toBe(nestedSidebars[1]);
    expect(pane).toHaveAttribute("data-presentation", "docked");
    expect(pane).toHaveClass(
      "w-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-2px)]!",
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
    const paneHeading = within(pane).getByRole("heading", { name: "音频" });
    const importButton = screen.getByRole("button", {
      name: "导入音频",
    });
    expect(fixedPaneHeader).toContainElement(paneHeading);
    expect(paneHeading).toHaveClass("text-sm", "font-semibold");
    expect(pane).not.toContainElement(importButton);
    expect(fixedPaneFooter).toBeNull();
    expect(
      fixedPaneHeader?.compareDocumentPosition(scrollingPaneContent!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(pane.querySelector("[data-context-pane-search]")).toContainElement(
      within(pane).getByRole("searchbox", { name: "搜索音频" }),
    );
    expect(insetHeader).not.toContainElement(contextTrigger);
    expect(fixedPaneHeader).toHaveClass("h-[50px]");
    expect(pane).toHaveClass("bg-background", "text-foreground");
    expect(insetHeader).toHaveClass("h-[50px]");
    expect(insetHeader).not.toHaveAttribute("style");
    expect(
      within(pane).queryByRole("group", { name: "录音操作" }),
    ).not.toBeInTheDocument();
    expect(insetHeader).toContainElement(importButton);

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!).toHaveAttribute("data-slot", "sidebar-inset");
    expect(mains[0]).toHaveClass("z-30", "min-w-0", "overflow-hidden");
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
    expect(document.getElementById("main-content")).toHaveClass("p-4");
    expect(document.getElementById("main-content")).not.toHaveClass("sm:p-6");
    expect(mains[0]!.querySelector("header")).toHaveClass(
      "h-[50px]",
      "shrink-0",
      "border-b",
      "bg-background",
    );
    expect(mains[0]!.querySelector("header")).not.toHaveClass(
      "sticky",
      "top-0",
    );

    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(outer).toHaveAttribute("data-state", "expanded");
    expect(
      inner!.querySelectorAll(':scope > [data-slot="sidebar"]'),
    ).toHaveLength(2);
    const settingsPane = screen.getByRole("complementary", {
      name: "设置上下文面板",
    });
    expect(settingsPane).toBeVisible();
    expect(
      screen
        .getByRole("complementary", { name: "设置上下文面板" })
        .querySelector("[data-context-pane-fixed-header]"),
    ).toHaveClass("h-[50px]");
    expect(
      within(navigation).getByLabelText("个人中心（即将推出）"),
    ).toHaveAttribute("data-shell-profile-placeholder", "true");
    const settingsContent = document.getElementById("main-content");
    expect(settingsContent).not.toHaveClass("p-4", "sm:p-6");
    expect(mains[0]!.querySelector("header")).toHaveClass(
      "h-[50px]",
      "border-b",
    );
    expect(document.querySelector("[data-settings-page]")).toHaveClass(
      "bg-muted/20",
    );
    await waitFor(() => {
      expect(api.preflightCapture).toHaveBeenCalled();
      expect(getFloatingCapturePreference).toHaveBeenCalled();
      expect(api.getAiSettings).toHaveBeenCalled();
      expect(getLocalModelSnapshot).toHaveBeenCalled();
      expect(onLocalModelSnapshot).toHaveBeenCalled();
    });
    const settingsInitializationCounts = {
      preflight: vi.mocked(api.preflightCapture).mock.calls.length,
      floatingCapture: getFloatingCapturePreference.mock.calls.length,
      ai: vi.mocked(api.getAiSettings).mock.calls.length,
      localModels: getLocalModelSnapshot.mock.calls.length,
      localModelSubscription: onLocalModelSnapshot.mock.calls.length,
    };
    expect(
      screen.getByRole("heading", { name: "通用", level: 1 }),
    ).toBeVisible();
    for (const heading of ["通用", "录制", "本地模型", "云端模型"]) {
      expect(
        screen.queryByRole("heading", { name: heading, level: 2 }),
      ).not.toBeInTheDocument();
    }
    expect(
      within(settingsPane).queryByRole("link", { name: "隐私与安全" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "隐私与安全", level: 2 }),
    ).not.toBeInTheDocument();
    const generalSection = document.querySelector(
      '[data-settings-section="general"]',
    );
    const recordingSection = document.querySelector(
      '[data-settings-section="recording"]',
    );
    const localModelsSection = document.querySelector(
      '[data-settings-section="local-models"]',
    );
    const cloudModelsSection = document.querySelector(
      '[data-settings-section="cloud-models"]',
    );
    expect(generalSection).not.toHaveAttribute("hidden");
    expect(recordingSection).toHaveAttribute("hidden");
    expect(localModelsSection).toHaveAttribute("hidden");
    expect(cloudModelsSection).toHaveAttribute("hidden");
    expect(
      screen.queryByRole("region", { name: "音频智能设置" }),
    ).not.toBeInTheDocument();

    const settingsNavigation = within(settingsPane).getByRole("navigation", {
      name: "设置分类",
    });
    const generalSetting = within(settingsNavigation).getByRole("button", {
      name: "通用",
    });
    const recordingSetting = within(settingsNavigation).getByRole("button", {
      name: "录制",
    });
    const localModelsSetting = within(settingsNavigation).getByRole("button", {
      name: "本地模型",
    });
    const cloudSetting = within(settingsNavigation).getByRole("button", {
      name: "云端模型",
    });
    expect(
      within(settingsNavigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["通用", "录制", "本地模型", "云端模型"]);
    expect(
      settingsNavigation.querySelector("a[href^='#settings-section-']"),
    ).not.toBeInTheDocument();
    expect(generalSetting).toHaveAttribute("data-active", "true");
    expect(generalSetting).toHaveAttribute("aria-current", "location");
    expect(generalSetting).toHaveClass(
      "aria-[current=location]:bg-accent/60",
      "rounded-none",
    );
    expect(generalSetting).toHaveAttribute("data-slot", "item");
    expect(generalSetting).toHaveAttribute("data-variant", "context");
    expect(localModelsSetting).toHaveAttribute("data-active", "false");
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(settingsContent!, "scrollTop", {
      configurable: true,
      value: 300,
      writable: true,
    });
    await user.click(recordingSetting);
    expect(
      await screen.findByRole("heading", { name: "录制", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "录制", level: 2 }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "通用", level: 2 }),
    ).not.toBeInTheDocument();
    expect(generalSection).toHaveAttribute("hidden");
    expect(recordingSection).not.toHaveAttribute("hidden");
    expect(settingsContent).toHaveProperty("scrollTop", 0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(recordingSetting).toHaveFocus();
    const floatingCaptureRow = screen.getByRole("switch", {
      name: "悬浮控制条",
    }).parentElement;
    expect(generalSection).not.toContainElement(floatingCaptureRow);
    expect(recordingSection).toContainElement(floatingCaptureRow);
    expect(floatingCaptureRow).toHaveAttribute("data-slot", "field");
    expect(floatingCaptureRow).toHaveClass("items-center!", "p-4");
    expect(
      screen.getByText("录制音频时在桌面右上角显示状态和控件"),
    ).toBeVisible();
    expect(floatingCaptureRow?.parentElement).toHaveClass(
      "[&_[data-slot=field-label]]:text-sm",
      "[&_[data-slot=field-label]]:leading-5",
      "[&_[data-slot=field-description]]:text-xs",
      "[&_[data-slot=field-description]]:leading-4",
    );
    await user.click(screen.getByText("悬浮控制条"));
    expect(api.setFloatingCapturePreference).not.toHaveBeenCalled();
    expect(
      screen.getByRole("switch", { name: "悬浮控制条" }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("switch", { name: "悬浮控制条" }));
    expect(api.setFloatingCapturePreference).toHaveBeenCalledOnce();
    expect(api.setFloatingCapturePreference).toHaveBeenCalledWith(true);
    expect(recordingSetting).toHaveAttribute("aria-current", "location");
    expect(generalSetting).not.toHaveAttribute("aria-current");
    await user.click(localModelsSetting);
    expect(
      await screen.findByRole("heading", { name: "本地模型", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "本地模型", level: 2 }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "录制", level: 2 }),
    ).not.toBeInTheDocument();
    expect(localModelsSection).not.toHaveAttribute("hidden");
    expect(recordingSection).toHaveAttribute("hidden");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(localModelsSetting).toHaveFocus();
    expect(localModelsSetting).toHaveAttribute("data-active", "true");
    expect(localModelsSetting).toHaveAttribute("aria-current", "location");
    expect(generalSetting).toHaveAttribute("data-active", "false");
    expect(generalSetting).not.toHaveAttribute("aria-current");
    expect(settingsContent).not.toHaveClass("p-4", "sm:p-6");
    expect(
      await screen.findByRole("region", { name: "本地模型设置" }),
    ).toBeVisible();

    settingsContent!.scrollTop = 240;
    fireEvent.scroll(settingsContent!);
    expect(localModelsSetting).toHaveAttribute("aria-current", "location");
    expect(settingsContent).toHaveProperty("scrollTop", 240);

    await user.click(cloudSetting);
    expect(
      await screen.findByRole("heading", { name: "云端模型", level: 1 }),
    ).toBeVisible();
    expect(cloudModelsSection).not.toHaveAttribute("hidden");
    expect(localModelsSection).toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "新增云端模型" }));
    expect(
      await screen.findByRole("dialog", { name: "新增云端模型" }),
    ).toBeVisible();
    fireEvent.click(recordingSetting);
    expect(cloudSetting).toHaveAttribute("aria-current", "location");
    expect(recordingSetting).not.toHaveAttribute("aria-current");
    expect(cloudModelsSection).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "后退" }));
    expect(
      await screen.findByRole("heading", { name: "本地模型", level: 1 }),
    ).toBeVisible();
    expect(localModelsSetting).toHaveAttribute("aria-current", "location");
    expect(localModelsSection).not.toHaveAttribute("hidden");
    expect(cloudModelsSection).toHaveAttribute("hidden");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector('[data-settings-section="recording"]')).toBe(
      recordingSection,
    );
    expect(
      document.querySelector('[data-settings-section="local-models"]'),
    ).toBe(localModelsSection);
    expect(vi.mocked(api.preflightCapture).mock.calls).toHaveLength(
      settingsInitializationCounts.preflight,
    );
    expect(getFloatingCapturePreference.mock.calls).toHaveLength(
      settingsInitializationCounts.floatingCapture,
    );
    expect(vi.mocked(api.getAiSettings).mock.calls).toHaveLength(
      settingsInitializationCounts.ai,
    );
    expect(getLocalModelSnapshot.mock.calls).toHaveLength(
      settingsInitializationCounts.localModels,
    );
    expect(onLocalModelSnapshot.mock.calls).toHaveLength(
      settingsInitializationCounts.localModelSubscription,
    );
    expect(cloudSetting.querySelector(".lucide-cloud")).not.toBeNull();
    expect(cloudSetting.querySelector(".lucide-bot")).toBeNull();
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

  it("focuses the visible local-model heading only for the programmatic settings entry", async () => {
    const api = installApi(
      {
        ...readySnapshot,
        capability: {
          processing: "unavailable",
          reason: "当前设备缺少本地处理运行时",
        },
        capture: { phase: "idle" },
      },
      {
        openAudio: vi.fn(async () => shellWorkspace(shellAudio)),
      },
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "打开 音频 A.wav" }),
    );
    await user.click(screen.getByRole("button", { name: "开始转写" }));
    await user.click(
      await screen.findByRole("button", { name: "前往本地模型" }),
    );
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));

    const localModelsHeading = await screen.findByRole("heading", {
      name: "本地模型",
      level: 1,
    });
    expect(localModelsHeading).toHaveFocus();
    expect(localModelsHeading).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "录制", level: 2 }),
    ).not.toBeInTheDocument();
  });

  it("restores recording in the content area without global header controls", async () => {
    const api = installApi(recordingSnapshot);
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("status", { name: "正在加载工作台" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "产品周会" }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-shell-slot="custom-title"]'),
    ).toBeVisible();
    expect(
      document.querySelector('[data-slot="sidebar-inset"] > header'),
    ).toHaveClass("h-[50px]");
    expect(document.getElementById("main-content")).toHaveClass(
      "p-4",
      "sm:p-6",
    );
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
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /音频上下文面板/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: /音频上下文面板宽度/ }),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "正在录音" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "录制详情" }),
    ).not.toHaveTextContent("产品周会");
    expect(
      screen.queryByRole("region", { name: "录制准备" }),
    ).not.toBeInTheDocument();
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
  });

  it("suppresses the audio pane and top bar for true-empty without changing the saved preference", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ audio: "open" }),
    );
    const writes = vi.spyOn(Storage.prototype, "setItem");
    installApi(
      { ...readySnapshot, capture: { phase: "idle" } },
      { listAudios: vi.fn(async () => []) },
    );
    render(<App />);

    expect(await screen.findByText("开始你的第一段音频")).toBeVisible();
    expect(
      document.querySelector('[data-shell-slot="content-head"]'),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "后退" })).toBeNull();
    expect(screen.queryByRole("button", { name: "前进" })).toBeNull();
    expect(screen.getByRole("button", { name: "导入外部音频" })).toBeVisible();
    expect(screen.getByRole("region", { name: "首次使用音频" })).toHaveClass(
      "flex-1",
      "justify-center",
    );
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /音频上下文面板/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: /音频上下文面板宽度/ }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar-gap"]')).toHaveClass(
      "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
    );
    expect(screen.getByRole("main")).not.toHaveClass(
      "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]",
    );
    expect(writes).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("voice2text.shell.context-panes.v1"),
    ).toBe(JSON.stringify({ audio: "open" }));
  });

  it.each(["open", "closed"] as const)(
    "restores the saved %s audio pane after initial loading",
    async (preference) => {
      window.localStorage.setItem(
        "voice2text.shell.context-panes.v1",
        JSON.stringify({ audio: preference }),
      );
      const writes = vi.spyOn(Storage.prototype, "setItem");
      const listAudios = deferred<Array<typeof shellAudio>>();
      installApi(
        { ...readySnapshot, capture: { phase: "idle" } },
        { listAudios: vi.fn(() => listAudios.promise) },
      );
      render(<App />);

      expect(
        await screen.findByRole("status", { name: "正在加载音频" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("complementary", { name: "音频上下文面板" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /音频上下文面板/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "导入音频" })).toBeNull();
      expect(screen.getByRole("main")).not.toHaveClass(
        "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]",
      );

      await act(async () => listAudios.resolve([shellAudio]));

      if (preference === "open") {
        expect(
          await screen.findByRole("complementary", {
            name: "音频上下文面板",
          }),
        ).toBeVisible();
        expect(
          document.querySelector(
            '[data-slot="sidebar-wrapper"] > [data-slot="sidebar"]',
          ),
        ).toHaveAttribute("data-state", "expanded");
      } else {
        expect(
          await screen.findByRole("button", { name: "打开音频上下文面板" }),
        ).toBeVisible();
        expect(screen.getByRole("main")).not.toHaveClass(
          "ml-[calc(var(--sidebar-width)-var(--sidebar-width-icon)-1px)]",
        );
      }
      expect(writes).not.toHaveBeenCalled();
      expect(
        window.localStorage.getItem("voice2text.shell.context-panes.v1"),
      ).toBe(JSON.stringify({ audio: preference }));
    },
  );

  it("hides and restores the pane and top bar as the audio library becomes empty and populated", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ audio: "open" }),
    );
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const listAudios = vi
      .fn()
      .mockResolvedValueOnce([shellAudio])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([shellAudio]);
    let publish: ((snapshot: ApplicationSnapshot) => void) | undefined;
    const initial = {
      ...readySnapshot,
      library: { phase: "ready" as const, audioCount: 1 },
      capture: { phase: "idle" as const },
    };
    installApi(initial, {
      listAudios,
      onApplicationSnapshot: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    render(<App />);

    expect(
      await screen.findByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    const audioNavigation = screen.getByRole("button", { name: "音频" });
    audioNavigation.focus();
    writes.mockClear();

    act(() =>
      publish?.({
        ...initial,
        revision: initial.revision + 1,
        library: { phase: "ready", audioCount: 0 },
      }),
    );

    expect(await screen.findByText("开始你的第一段音频")).toBeVisible();
    expect(
      document.querySelector('[data-shell-slot="content-head"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /音频上下文面板/ })).toBeNull();
    expect(audioNavigation).toHaveFocus();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(document.querySelector("[aria-live]")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Notifications"),
    );
    expect(writes).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("voice2text.shell.context-panes.v1"),
    ).toBe(JSON.stringify({ audio: "open" }));

    act(() => publish?.({ ...initial, revision: initial.revision + 2 }));

    expect(
      await screen.findByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-shell-slot="content-head"]'),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "后退" })).toBeVisible();
  });

  it("keeps recording setup fullscreen after the back action is removed", async () => {
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
        capture: { phase: "idle" },
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
      await screen.findByRole("button", { name: "新录音2026090501" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "设置音频录制" })).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开 已有录音.wav" }),
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
      await screen.findByRole("complementary", { name: "音频上下文面板" }),
    ).toBeVisible();
    expect(writes).not.toHaveBeenCalled();

    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.getByRole("complementary", { name: "设置上下文面板" }),
    ).toBeVisible();
    expect(
      screen
        .getByRole("complementary", { name: "设置上下文面板" })
        .querySelector("[data-context-pane-fixed-header]"),
    ).toHaveClass("h-[50px]");
    expect(writes).not.toHaveBeenCalled();

    await user.click(within(navigation).getByRole("button", { name: "互联" }));
    expect(
      await screen.findByRole("complementary", { name: "互联上下文面板" }),
    ).toBeVisible();
    expect(
      screen
        .getByRole("complementary", { name: "互联上下文面板" })
        .querySelector("[data-context-pane-fixed-header]"),
    ).toHaveClass("h-[50px]");
    expect(document.getElementById("main-content")).toHaveClass(
      "p-4",
      "sm:p-6",
    );
    await user.click(
      screen.getByRole("button", { name: "收起互联上下文面板" }),
    );
    expect(
      screen.getByRole("button", { name: "打开互联上下文面板" }),
    ).toHaveFocus();
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
    ).not.toContainElement(openAudioPane);
    expect(
      document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]'),
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

  it("hides the message chrome while empty and restores the saved pane state when a message arrives", async () => {
    window.localStorage.setItem(
      "voice2text.shell.context-panes.v1",
      JSON.stringify({ messages: "closed" }),
    );
    let publish: ((snapshot: ApplicationSnapshot) => void) | undefined;
    const initial = { ...readySnapshot, capture: { phase: "idle" as const } };
    installApi(initial, {
      onApplicationSnapshot: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "消息" }));
    expect(screen.getByRole("heading", { name: "还没有消息" })).toBeVisible();
    expect(
      document.querySelector('[data-shell-slot="content-head"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "消息上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开消息上下文面板" }),
    ).not.toBeInTheDocument();
    expect(document.getElementById("main-content")).not.toHaveClass("p-4");

    act(() =>
      publish?.({
        ...initial,
        revision: initial.revision + 1,
        activity: [
          {
            id: "capture:completed:message-restored",
            kind: "capture_completed",
            captureSessionId: "message-restored",
            createdAt: 100,
            title: "录音已完成",
            severity: "info",
            read: true,
            resolved: true,
            detailTarget: "capture-details",
          },
        ],
      }),
    );

    expect(screen.queryByText("还没有消息")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-shell-slot="content-head"]'),
    ).toBeVisible();
    expect(document.getElementById("main-content")).toHaveClass(
      "p-4",
      "sm:p-6",
    );
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
          head={<button type="button">新录音</button>}
          search={<input type="search" aria-label="搜索音频" />}
          filters={<button type="button">全部 1</button>}
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
    const fixedHeader = pane.querySelector("[data-context-pane-head]");
    const searchRegion = pane.querySelector("[data-context-pane-search]");
    const filterRegion = pane.querySelector("[data-context-pane-filters]");
    const scrollingContent = pane.querySelector(
      "[data-context-pane-scrolling-content]",
    );
    expect(fixedHeader).toContainElement(
      screen.getByRole("heading", { name: "音频" }),
    );
    expect(searchRegion).toContainElement(
      screen.getByRole("searchbox", { name: "搜索音频" }),
    );
    expect(fixedHeader).toContainElement(
      screen.getByRole("button", { name: "新录音" }),
    );
    expect(filterRegion).toContainElement(
      screen.getByRole("button", { name: "全部 1" }),
    );
    expect(fixedHeader).toHaveClass("h-[50px]");
    expect(searchRegion).toHaveClass("h-[45px]");
    expect(pane).toHaveClass("bg-background", "text-foreground");
    expect(scrollingContent).toContainElement(
      screen.getByRole("button", { name: "选择音频 A" }),
    );
    expect(fixedHeader?.compareDocumentPosition(scrollingContent!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(searchRegion?.compareDocumentPosition(filterRegion!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(filterRegion?.compareDocumentPosition(scrollingContent!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps a profile blocker latched through recheck failure", async () => {
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
    const requestBootstrapAction = vi.fn(async () => {
      throw new Error("raw /private/profile/path failure");
    });
    const api = installApi(blocked, { requestBootstrapAction });
    const user = userEvent.setup();
    render(<App />);

    const blocker = await screen.findByRole("dialog", {
      name: "本机资料库暂不可用",
    });
    expect(blocker).toHaveTextContent("请释放一些磁盘空间，然后重新检查。");
    expect(screen.queryByText("查看修复建议")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "工作站主导航" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(api.requestBootstrapAction).toHaveBeenCalledWith("recheck");
    expect(blocker).toBeInTheDocument();
    expect(await screen.findByText("无法重新检查，请重试。")).toBeVisible();
    expect(screen.queryByText(/private\/profile/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  });

  it("keeps one blocker mounted until a newer ready snapshot", async () => {
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
    const initializing: ApplicationSnapshot = {
      ...readySnapshot,
      revision: blocked.revision + 1,
      profile: { phase: "initializing" },
      capture: { phase: "idle" },
    };
    const blockedAgain: ApplicationSnapshot = {
      ...blocked,
      revision: initializing.revision + 1,
      profile: {
        phase: "blocked",
        code: "filesystem_unavailable",
        message: "raw path detail",
        repairable: true,
      },
    };
    const ready: ApplicationSnapshot = {
      ...readySnapshot,
      revision: blockedAgain.revision + 1,
      capture: { phase: "idle" },
    };
    const listAudios = vi.fn(async () => []);
    let publish: ((snapshot: ApplicationSnapshot) => void) | undefined;
    let resolveRecheck: ((snapshot: ApplicationSnapshot) => void) | undefined;
    const requestBootstrapAction = vi.fn(
      async () =>
        await new Promise<ApplicationSnapshot>((resolve) => {
          resolveRecheck = resolve;
        }),
    );
    const api = installApi(blocked, {
      listAudios,
      requestBootstrapAction,
      onApplicationSnapshot: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    window.history.replaceState(null, "", "/#/settings");
    render(<App />);

    const blocker = await screen.findByRole("dialog", {
      name: "本机资料库暂不可用",
    });
    expect(listAudios).not.toHaveBeenCalled();
    expect(api.navigate).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/audio");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重新检查" }));
    await user.click(screen.getByRole("button", { name: "正在检查" }));
    expect(requestBootstrapAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在检查" })).toBeDisabled();

    act(() => publish?.(initializing));
    expect(blocker).toBeInTheDocument();
    act(() => publish?.(blockedAgain));
    expect(blocker).toBeInTheDocument();
    expect(blocker).toHaveTextContent(
      "请检查本机存储和文件权限，然后重新检查。",
    );

    act(() => publish?.({ ...ready, revision: blockedAgain.revision }));
    expect(blocker).toBeInTheDocument();
    await act(async () => resolveRecheck?.(blockedAgain));
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();

    act(() => publish?.(ready));

    expect(await screen.findByText("开始你的第一段音频")).toBeVisible();
    expect(listAudios).toHaveBeenCalledTimes(1);
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("renders route-local Audio loading and recoverable error states", async () => {
    const pending = new Promise<never>(() => undefined);
    const first = installApi(
      { ...readySnapshot, capture: { phase: "idle" } },
      { listAudios: vi.fn(() => pending) },
    );
    const view = render(<App />);
    expect(
      await screen.findByRole("status", { name: "正在加载音频" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /音频上下文面板/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "导入音频" })).toBeNull();
    view.unmount();

    first.listAudios = vi.fn(async () => {
      throw new Error("读取失败");
    });
    Object.defineProperty(window, "voice2text", {
      configurable: true,
      value: first,
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法载入音频列表",
    );
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /音频上下文面板/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "导入音频" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新载入" })).toBeEnabled();
  });

  it("keeps import and recording available without local processing", async () => {
    const api = installApi(
      {
        ...readySnapshot,
        connectivity: "offline",
        capability: {
          processing: "unavailable",
          reason: "当前设备缺少本地处理运行时",
        },
        navigation: { section: "tasks" },
        capture: { phase: "idle" },
      },
      {
        listAudios: vi.fn(async () => []),
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "dual_track" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "granted" as const,
          microphones: [
            { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
          ],
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: false,
          canStart: true,
          blockingReasons: [],
        })),
      },
    );
    render(<App />);
    expect(
      await screen.findByRole("status", { name: "离线状态" }),
    ).toHaveTextContent("离线");
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("library"));
    expect(screen.getByRole("button", { name: "音频" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("dialog", { name: "本地处理不可用" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "开始录制" }),
    ).toBeEnabled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "导入外部音频" }));
    expect(
      screen.queryByRole("dialog", { name: "本地处理不可用" }),
    ).not.toBeInTheDocument();
    expect(api.importAudio).toHaveBeenCalledOnce();
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
      screen.queryByRole("complementary", { name: "消息上下文面板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "还没有消息" }),
    ).toBeVisible();
    expect(screen.queryByText("启动恢复需要确认")).not.toBeInTheDocument();

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
      screen.getByRole("heading", { level: 2, name: "还没有消息" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "消息上下文面板" }),
    ).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "云端模型" }));
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

  it("prompts for recoveries before normal audio navigation", async () => {
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
      title: "Recover-录制中断，需要处理",
      capability: "restorable" as const,
      reason: null,
    };
    const otherRecovery = {
      ...targetedRecovery,
      sessionId: "session-other-recovery-12345",
      title: "Recover-另一段录制",
      captureTimelineMs: 4_000,
    };
    const actOnCaptureRecovery = vi.fn(async () => ({
      outcomes: [otherRecovery, targetedRecovery].map((item) => ({
        sessionId: item.sessionId,
        action: "keep" as const,
        result: "kept" as const,
        completionCertainty: "completed" as const,
        audioDurability: "durable" as const,
        transcriptionHandoff: "completed" as const,
        capture: item,
      })),
      recoveries: [],
    }));
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
    render(<App />);

    const recoveryDialog = await screen.findByRole("dialog", {
      name: "发现可恢复的录音",
    });
    expect(
      within(recoveryDialog).getByText(/发现 2 段可恢复录音/),
    ).toBeVisible();
    expect(
      within(recoveryDialog).queryByText("Recover-录制中断，需要处理"),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "录制详情", level: 1 }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();
    await userEvent
      .setup()
      .click(within(recoveryDialog).getByRole("button", { name: "立即恢复" }));
    await waitFor(() => expect(actOnCaptureRecovery).toHaveBeenCalledOnce());
    expect(actOnCaptureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: [otherRecovery.sessionId, targetedRecovery.sessionId],
        action: "keep",
        intent: "user-decision",
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
