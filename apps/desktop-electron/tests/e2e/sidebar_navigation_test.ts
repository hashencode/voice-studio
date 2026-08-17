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
    getApplicationSnapshot: vi.fn(async () => snapshot),
    navigate,
    requestBootstrapAction: vi.fn(async () => snapshot),
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

const restored: ApplicationSnapshot = {
  protocolVersion: 2,
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
  it("supports rail tooltips, roving keys, selection and restored snapshots", async () => {
    const { api } = applicationApi(restored);
    const user = userEvent.setup();
    const first = render(createElement(App));

    const navigation = await screen.findByRole("navigation", {
      name: "工作站主导航",
    });
    const companion = within(navigation).getByRole("button", {
      name: "互联",
    });
    expect(companion).toHaveAttribute("aria-current", "page");
    expect(companion).toHaveAttribute("tabindex", "0");
    expect(
      within(navigation).getByRole("button", { name: "音频" }),
    ).toHaveAttribute("tabindex", "-1");
    companion.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("互联");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(
      within(navigation).getByRole("button", { name: "设置" }),
    ).toHaveFocus();

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
        screen.getByRole("complementary", { name: "录制工作区" }),
      ).toHaveTextContent("访谈");
    },
  );

  it("derives an 880px non-modal overlay without preference writes and preserves focus semantics", async () => {
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
    expect(pane).toHaveAttribute("data-presentation", "overlay");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "工作站主导航" }),
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "录制工作区" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("启动恢复需要确认");
    expect(writes).not.toHaveBeenCalled();

    window.innerWidth = 1280;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(pane).toHaveAttribute("data-presentation", "docked"),
    );
    window.innerWidth = 880;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(pane).toHaveAttribute("data-presentation", "overlay"),
    );
    expect(writes).not.toHaveBeenCalled();

    const settings = screen.getByRole("button", { name: "设置" });
    settings.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith("settings"));
    expect(settings).toHaveFocus();
    expect(writes).not.toHaveBeenCalled();

    const audio = screen.getByRole("button", { name: "音频" });
    await user.click(audio);
    const close = await screen.findByRole("button", {
      name: "关闭音频上下文面板",
    });
    await user.click(close);
    expect(writes).toHaveBeenCalledTimes(1);
    const trigger = screen.getByRole("button", {
      name: "打开音频上下文面板",
    });
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(writes).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    expect(writes).toHaveBeenCalledTimes(3);
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(writes).toHaveBeenCalledTimes(4);
    fireEvent.pointerDown(document.getElementById("main-content")!);
    expect(writes).toHaveBeenCalledTimes(5);
    expect(trigger).toHaveFocus();
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
      await screen.findByRole("heading", { name: "项目周会.wav" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "互联" }));
    expect(
      await screen.findByRole("heading", { name: "互联", level: 1 }),
    ).toBeVisible();
    await waitFor(() =>
      expect(controlAudioPlayback).toHaveBeenCalledWith(4, {
        action: "close",
      }),
    );
    expect(controlAudioPlayback).toHaveBeenCalledTimes(1);
  });
});
