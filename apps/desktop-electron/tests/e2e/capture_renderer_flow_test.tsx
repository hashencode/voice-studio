// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/renderer/App";
import type {
  ApplicationSnapshot,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";
import { companionRendererStubs } from "../fixtures/companion";

const initial: ApplicationSnapshot = {
  protocolVersion: 3,
  revision: 10,
  navigation: { section: "library" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: {
    phase: "recording",
    sessionId: "session-renderer-e2e-123456",
    title: "跨页面访谈",
    elapsedMs: 12_000,
    captureMode: "dual_track",
  },
  libraryProjection: { phase: "idle" },
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function installApi() {
  let snapshot = initial;
  let applicationListener: ((value: ApplicationSnapshot) => void) | undefined;
  const api = {
    ...companionRendererStubs(),
    getAiSettings: vi.fn(async () => ({
      revision: 1,
      profiles: [
        {
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
        },
      ],
      selectedProfileId: "profile-deepseek",
      deviceSecurity: {
        kind: "device-security" as const,
        fileVaultState: "unknown" as const,
        applicationLayerEncryption: "not-claimed" as const,
      },
    })),
    createAiProviderProfile: vi.fn(),
    updateAiProviderProfile: vi.fn(),
    selectAiProviderProfile: vi.fn(),
    deleteAiProviderProfile: vi.fn(),
    getApplicationSnapshot: vi.fn(async () => snapshot),
    navigate: vi.fn(
      async (section: ApplicationSnapshot["navigation"]["section"]) => {
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          navigation: { section },
        };
        return snapshot;
      },
    ),
    requestBootstrapAction: vi.fn(async () => snapshot),
    onApplicationSnapshot: vi.fn(
      (listener: (value: ApplicationSnapshot) => void) => {
        applicationListener = listener;
        return () => {
          applicationListener = undefined;
        };
      },
    ),
    listProcessingTasks: vi.fn(async () => []),
    onOperationEvent: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => []),
    openAudio: vi.fn(async () => null),
    listCaptureRecoveries: vi.fn(async () => []),
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
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    })),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    suggestCaptureTitle: vi.fn(async () => ({ title: "新录音2026090501" })),
    renameCaptureSession: vi.fn(async ({ title }) => {
      if (snapshot.capture.phase === "idle") return snapshot;
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        capture: { ...snapshot.capture, title },
      };
      return snapshot;
    }),
    actOnCaptureRecovery: vi.fn(),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    onCaptionSnapshot: vi.fn(() => () => undefined),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return {
    api,
    publish(value: ApplicationSnapshot) {
      snapshot = value;
      applicationListener?.(value);
    },
  };
}

describe("capture Renderer flow", () => {
  it("composes recording controls in the fixed Shell footer without duplicating them in content", async () => {
    installApi();
    render(createElement(App));

    const footer = await screen.findByRole("contentinfo");
    expect(footer).toHaveAttribute("data-shell-slot", "content-footer");
    expect(within(footer).getByText("正在录制")).toBeVisible();
    expect(within(footer).getByText("00:12")).toBeVisible();
    expect(
      within(footer).getByRole("button", { name: "暂停录制" }),
    ).toBeEnabled();
    expect(
      within(footer).getByRole("button", { name: "停止并保存" }),
    ).toBeEnabled();

    const content = document.querySelector('[data-shell-slot="content"]');
    expect(content).not.toBeNull();
    expect(within(content as HTMLElement).queryByText("正在录制")).toBeNull();
    expect(
      within(content as HTMLElement).queryByRole("button", {
        name: "暂停录制",
      }),
    ).toBeNull();
    expect(screen.queryByText(/切换页面不会停止|安全保存到本机/)).toBeNull();
  });

  it("keeps one application-owned workspace while recording focus reflects state events", async () => {
    const bridge = installApi();
    render(createElement(App));

    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("跨页面访谈")).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "工作站主导航" }),
    ).not.toBeInTheDocument();

    bridge.publish({
      ...initial,
      revision: 12,
      navigation: { section: "library" },
      capture: {
        phase: "paused",
        sessionId: "session-renderer-e2e-123456",
        title: "跨页面访谈",
        elapsedMs: 14_000,
        captureMode: "dual_track",
        interruptionReason: "system_wake_requires_resume",
        message: "电脑已唤醒，请确认后手动继续录制。",
      },
    });
    expect(await screen.findByText("等待你确认继续录制")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "确认并继续录制" }),
    ).toBeEnabled();
  });

  it("restores the capture snapshot and recovery list after Renderer reload", async () => {
    const bridge = installApi();
    const first = render(createElement(App));
    const title = await screen.findByRole("button", { name: "跨页面访谈" });
    await userEvent.setup().click(title);
    const input = screen.getByRole("textbox", { name: "录制名称" });
    expect(input).toHaveFocus();
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, "跨页面客户访谈");
    input.blur();
    await waitFor(() =>
      expect(bridge.api.renameCaptureSession).toHaveBeenCalledWith({
        sessionId: "session-renderer-e2e-123456",
        title: "跨页面客户访谈",
      }),
    );
    first.unmount();

    render(createElement(App));
    expect(await screen.findByText("跨页面客户访谈")).toBeVisible();
    await waitFor(() =>
      expect(bridge.api.getApplicationSnapshot).toHaveBeenCalledTimes(2),
    );
    expect(bridge.api.listCaptureRecoveries).toHaveBeenCalledTimes(2);
  });
});
