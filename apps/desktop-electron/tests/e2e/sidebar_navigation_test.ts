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
    getAiSettings: vi.fn(async () => testAiSettings()),
    saveAiSettings: vi.fn(async () => testAiSettings()),
    replaceAiProviderSecret: vi.fn(async () => testAiSettings()),
    deleteAiProviderSecret: vi.fn(async () => testAiSettings()),
    prepareMeetingAi: vi.fn(),
    getMeetingAiSnapshot: vi.fn(async () => null),
    generateMeetingAi: vi.fn(),
    retryMeetingAi: vi.fn(),
    onMeetingAiSnapshot: vi.fn(() => () => undefined),
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => []),
    importMeeting: vi.fn(),
    listMeetings: vi.fn(async () => []),
    openMeeting: vi.fn(async () => null),
    searchTranscript: vi.fn(async () => []),
    editMeetingSegment: vi.fn(),
    undoMeetingEdit: vi.fn(),
    redoMeetingEdit: vi.fn(),
    renameMeetingSpeaker: vi.fn(),
    mergeMeetingSpeakers: vi.fn(),
    assignMeetingSpeaker: vi.fn(),
    controlMeetingPlayback: vi.fn(),
    exportMeeting: vi.fn(),
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

  it("closes meeting playback once when sidebar navigation unmounts the workspace", async () => {
    const meeting = {
      revision: 3,
      summary: {
        meetingId: 4,
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
      library: { phase: "ready", meetingCount: 1 },
      capture: { phase: "idle" },
    };
    const controlMeetingPlayback = vi.fn(async () => ({
      meetingId: 4,
      initialized: false,
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    }));
    applicationApi(initial, {
      listMeetings: vi.fn(async () => [meeting.summary]),
      openMeeting: vi.fn(async () => meeting),
      controlMeetingPlayback,
    });
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(
      await screen.findByRole("button", { name: /打开 项目周会/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "项目周会.wav" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Companion" }));
    expect(
      await screen.findByRole("heading", { name: "Companion" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(controlMeetingPlayback).toHaveBeenCalledWith(4, {
        action: "close",
      }),
    );
    expect(controlMeetingPlayback).toHaveBeenCalledTimes(1);
  });
});
