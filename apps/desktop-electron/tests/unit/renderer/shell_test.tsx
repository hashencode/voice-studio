// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
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
    const audio = within(navigation).getByRole("button", { name: "音频" });
    expect(audio).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getAllByRole("button")).toHaveLength(3);
    expect(
      within(navigation).queryByRole("button", { name: "转写任务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
    ).toHaveAttribute("data-presentation", "docked");

    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toHaveTextContent("产品周会");
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toBeVisible();
  });

  it("keeps independent first-use pane preferences and hides settings without writing", async () => {
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
    expect(screen.queryByLabelText("上下文面板")).not.toBeInTheDocument();
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
    const triggerRef = createRef<HTMLButtonElement>();
    const user = userEvent.setup();
    render(
      <>
        <button ref={triggerRef} type="button">
          trigger
        </button>
        <ContextPaneShell
          section="audio"
          presentation="overlay"
          triggerRef={triggerRef}
          onRequestClose={onRequestClose}
        >
          <button type="button">选择音频 A</button>
        </ContextPaneShell>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "选择音频 A" }));
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("complementary", { name: "音频上下文面板" }),
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

  it("surfaces reconciliation as explicit recovery without auto-retry", async () => {
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
      },
    );
    const user = userEvent.setup();
    render(<App />);
    const recovery = await screen.findByRole("alert");
    expect(recovery).toHaveTextContent("启动恢复需要确认");
    expect(recovery).toHaveTextContent("不会自动重试");
    expect(
      screen.getByRole("heading", { name: "还没有本机会议" }),
    ).toBeVisible();

    const reviewTasks = screen.getByRole("button", {
      name: "查看相关音频并选择重试",
    });
    reviewTasks.focus();
    await user.keyboard("{Enter}");
    expect(api.navigate).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "重试 中断的周会.wav" }),
    ).toBeEnabled();
    expect(api.retryProcessing).not.toHaveBeenCalled();
  });
});
