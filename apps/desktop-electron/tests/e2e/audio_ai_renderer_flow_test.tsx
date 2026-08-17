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

const application: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 12,
  navigation: { section: "library" },
  profile: { phase: "ready" },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "ready", audioCount: 1 },
  reconciliation: [],
  capture: { phase: "idle" },
};

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

const settings = {
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
  secretState: "available" as const,
  deviceSecurity: {
    kind: "device-security" as const,
    fileVaultState: "enabled" as const,
    applicationLayerEncryption: "not-claimed" as const,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function installApi() {
  let current = application;
  const aiSnapshot = {
    revision: 1,
    jobId: 51,
    audioId: 4,
    generationId: 9,
    providerId: "deepseek" as const,
    modelId: "deepseek-chat",
    endpointOrigin: "https://api.deepseek.com",
    endpointIdentitySha256: "c".repeat(64),
    transcriptScopeSha256: "b".repeat(64),
    attempt: 0,
    state: "completed" as const,
    errorCode: null,
    note: {
      noteId: 61,
      schemaVersion: "audio_intelligence_output/v1" as const,
      suggestedTitle: null,
      audioType: null,
      items: [
        {
          insightId: 71,
          kind: "action",
          body: "确认下周发布",
          evidence: [],
          actionOwner: null,
          actionDueAtMs: null,
        },
      ],
    },
  };
  const api = {
    getApplicationSnapshot: vi.fn(async () => current),
    navigate: vi.fn(
      async (section: ApplicationSnapshot["navigation"]["section"]) => {
        current = {
          ...current,
          revision: current.revision + 1,
          navigation: { section },
        };
        return current;
      },
    ),
    requestBootstrapAction: vi.fn(async () => current),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    listProcessingTasks: vi.fn(async () => []),
    onOperationEvent: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => [audio.summary]),
    openAudio: vi.fn(async () => audio),
    controlAudioPlayback: vi.fn(async () => ({
      audioId: 4,
      initialized: false,
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    })),
    listCaptureRecoveries: vi.fn(async () => []),
    getCaptionSnapshot: vi.fn(async () => null),
    onCaptionSnapshot: vi.fn(() => () => undefined),
    getAiSettings: vi.fn(async () => settings),
    saveAiSettings: vi.fn(async () => settings),
    replaceAiProviderSecret: vi.fn(async () => settings),
    deleteAiProviderSecret: vi.fn(async () => settings),
    getAudioAiSnapshot: vi.fn(async () => null),
    prepareAudioAi: vi.fn(async () => ({
      audioId: 4,
      generationId: 9,
      providerId: "deepseek" as const,
      modelId: "deepseek-chat",
      audioTitle: "项目周会.wav",
      endpointOrigin: "https://api.deepseek.com",
      endpointIdentitySha256: "c".repeat(64),
      transcriptScopeSha256: "b".repeat(64),
      segmentCount: 1,
      inputStartMs: 0,
      inputEndMs: 5_000,
      requiresConsent: true as const,
    })),
    generateAudioAi: vi.fn(async () => aiSnapshot),
    retryAudioAi: vi.fn(async () => aiSnapshot),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("audio AI Renderer e2e", () => {
  it("wires settings and exact-scope consent through the real application shell", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(createElement(App));

    await user.click(
      await screen.findByRole("button", { name: /打开 项目周会/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "生成云端音频草稿" }),
    );
    const consent = await screen.findByRole("dialog", {
      name: "本次音频云端处理同意",
    });
    await user.click(within(consent).getByRole("checkbox"));
    await user.click(
      within(consent).getByRole("button", { name: "同意并生成草稿" }),
    );
    expect(await screen.findByText("确认下周发布")).toBeVisible();
    expect(api.generateAudioAi).toHaveBeenCalledWith(
      expect.objectContaining({
        consent: expect.objectContaining({
          endpointIdentitySha256: "c".repeat(64),
          transcriptScopeSha256: "b".repeat(64),
        }),
      }),
    );

    const navigation = screen.getByRole("navigation", { name: "工作站主导航" });
    await user.click(within(navigation).getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("heading", { name: "可选音频智能" }),
    ).toBeVisible();
    await waitFor(() => expect(api.getAiSettings).toHaveBeenCalledTimes(1));
    expect(api.generateAudioAi).toHaveBeenCalledTimes(1);
  });
});
