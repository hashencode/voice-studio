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
  protocolVersion: 2,
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
    preflightCapture: vi.fn(),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
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
  it("keeps one application-owned workspace across navigation and reflects menu state events", async () => {
    const bridge = installApi();
    const user = userEvent.setup();
    render(createElement(App));

    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("跨页面访谈")).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "录制控制" }),
    ).not.toBeInTheDocument();

    bridge.publish({
      ...initial,
      revision: 12,
      navigation: { section: "settings" },
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
    await user.click(within(navigation).getByRole("button", { name: "音频" }));
    expect(
      await screen.findByRole("region", { name: "当前录制" }),
    ).toHaveTextContent("等待你确认继续录制");
    expect(
      screen.getByRole("button", { name: "确认并继续录制" }),
    ).toBeEnabled();
  });

  it("restores the capture snapshot and recovery list after Renderer reload", async () => {
    const bridge = installApi();
    const first = render(createElement(App));
    expect(await screen.findByText("跨页面访谈")).toBeVisible();
    first.unmount();

    render(createElement(App));
    expect(await screen.findByText("跨页面访谈")).toBeVisible();
    await waitFor(() =>
      expect(bridge.api.getApplicationSnapshot).toHaveBeenCalledTimes(2),
    );
    expect(bridge.api.listCaptureRecoveries).toHaveBeenCalledTimes(2);
  });
});
