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
  it("keeps the inline rail and overlay pane reachable below the shadcn mobile breakpoint", async () => {
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
    ).toHaveAttribute("data-presentation", "overlay");

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

    await screen.findByRole("heading", { name: "请选择音频", level: 1 });

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
    const contextTrigger = within(insetHeader!).getByRole("button", {
      name: "收起音频上下文面板",
    });
    expect(contextTrigger).toHaveAttribute("data-sidebar", "trigger");
    expect(contextTrigger).toHaveClass("size-7");
    expect(
      contextTrigger.querySelector("svg.lucide-panel-left"),
    ).not.toBeNull();
    expect(contextTrigger).not.toHaveTextContent(/[‹›]/);

    const pane = screen.getByRole("complementary", {
      name: "音频上下文面板",
    });
    expect(pane).toBe(nestedSidebars[1]);
    expect(pane).toHaveAttribute("data-presentation", "docked");
    const fixedPaneHeader = pane.querySelector<HTMLElement>(
      "[data-context-pane-fixed-header]",
    );
    const scrollingPaneContent = pane.querySelector<HTMLElement>(
      "[data-context-pane-scrolling-content]",
    );
    const headerControls = [
      within(pane).getByRole("heading", { name: "音频" }),
      within(pane).getByRole("searchbox", { name: "搜索音频" }),
      within(pane).getByRole("button", { name: "开始录音" }),
      within(pane).getByRole("button", { name: "导入音频" }),
    ];
    for (const control of headerControls) {
      expect(fixedPaneHeader).toContainElement(control);
    }
    expect(
      fixedPaneHeader?.compareDocumentPosition(scrollingPaneContent!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!).toHaveAttribute("data-slot", "sidebar-inset");
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

  it("restores navigation and keeps privacy-safe capture controls in the global header", async () => {
    const api = installApi(readySnapshot);
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("status", { name: "正在加载工作台" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "请选择音频", level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText("还没有音频")).toBeVisible();
    expect(screen.queryByText(/旧版资料库/)).not.toBeInTheDocument();

    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    const audio = within(navigation).getByRole("button", { name: "音频" });
    expect(audio).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getAllByRole("button")).toHaveLength(3);
    expect(
      within(navigation).queryByRole("button", { name: "转写任务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toHaveAttribute("data-presentation", "docked");

    const captureControl = screen.getByRole("complementary", {
      name: "录制控制",
    });
    expect(captureControl).toHaveTextContent("录制中");
    expect(captureControl).not.toHaveTextContent("产品周会");
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.getByRole("complementary", { name: "录制控制" }),
    ).toBeVisible();
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
      screen.getByRole("button", { name: "关闭互联上下文面板" }),
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

    expect(
      await screen.findByRole("button", { name: "打开音频上下文面板" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "音频上下文面板" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "互联" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("companion"));
    expect(
      screen.getByRole("complementary", { name: "互联上下文面板" }),
    ).toBeVisible();
  });

  it("does not treat context-pane child controls as dismissal", async () => {
    const onRequestClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SidebarProvider persistState={false} enableKeyboardShortcut={false}>
        <ContextPaneShell
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
    expect(screen.getByLabelText("消息中心")).toHaveTextContent("暂无消息");
    expect(
      screen.getByRole("heading", { name: "请选择音频", level: 1 }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    expect(api.navigate).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
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
    expect(screen.getByLabelText("消息中心")).toHaveTextContent("暂无消息");
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("treats a narrow settings selection as transient pane dismissal", async () => {
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
      screen.queryByRole("complementary", { name: "设置上下文面板" }),
    ).not.toBeInTheDocument();

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
