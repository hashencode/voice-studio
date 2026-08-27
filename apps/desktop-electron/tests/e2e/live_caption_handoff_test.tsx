// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/renderer/App";
import type {
  ApplicationSnapshot,
  CaptionSnapshot,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";

const application: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 12,
  navigation: { section: "library" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: {
    phase: "recording",
    sessionId: "session-caption-e2e-123456",
    title: "字幕交接音频",
    elapsedMs: 14_000,
    captureMode: "dual_track",
  },
};

const captions: CaptionSnapshot = {
  revision: 3,
  sessionId: "session-caption-e2e-123456",
  draft: {
    generationId: 31,
    attempt: 1,
    state: "running",
    utterances: [
      {
        sequence: 1,
        startMs: 0,
        endMs: 1_200,
        text: "这是恢复后的实时草稿。",
        language: "zh",
      },
    ],
    hasEarlierUtterances: false,
    backlogBytes: 0,
    errorCode: null,
  },
  formal: {
    generationId: null,
    attempt: 0,
    state: "not_queued",
    errorCode: null,
  },
  displayAuthority: "live_draft",
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function installApi() {
  let captionListener: ((snapshot: CaptionSnapshot) => void) | undefined;
  const getCaptionSnapshot = vi.fn(async () => captions);
  const retryFormalTranscript = vi.fn(async () => ({
    ...captions,
    revision: 5,
    formal: {
      generationId: 51,
      attempt: 2,
      state: "queued" as const,
      errorCode: null,
    },
  }));
  const api = {
    getApplicationSnapshot: vi.fn(async () => application),
    navigate: vi.fn(async () => application),
    requestBootstrapAction: vi.fn(async () => application),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    listProcessingTasks: vi.fn(async () => []),
    onOperationEvent: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => []),
    openAudio: vi.fn(async () => null),
    listCaptureRecoveries: vi.fn(async () => []),
    getCaptionSnapshot,
    retryFormalTranscript,
    onCaptionSnapshot: vi.fn(
      (listener: (snapshot: CaptionSnapshot) => void) => {
        captionListener = listener;
        return () => {
          captionListener = undefined;
        };
      },
    ),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return {
    getCaptionSnapshot,
    retryFormalTranscript,
    emit(snapshot: CaptionSnapshot) {
      act(() => captionListener?.(snapshot));
    },
  };
}

describe("live caption and formal handoff Renderer flow", () => {
  it("restores one draft after reload, exposes formal failure, and retries a new attempt", async () => {
    const bridge = installApi();
    const first = render(<App />);
    expect(
      await screen.findByRole("region", { name: "实时字幕与转写" }),
    ).toHaveTextContent("这是恢复后的实时草稿。");
    first.unmount();
    render(<App />);
    expect(await screen.findByText("这是恢复后的实时草稿。")).toBeVisible();
    await waitFor(() =>
      expect(bridge.getCaptionSnapshot).toHaveBeenCalledTimes(2),
    );

    bridge.emit({
      ...captions,
      revision: 4,
      formal: {
        generationId: 50,
        attempt: 1,
        state: "failed",
        errorCode: "FORMAL_WORKER_EXITED",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("实时草稿仍在");

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "重试正式转写" }));
    expect(bridge.retryFormalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: captions.sessionId,
        expectedAttempt: 1,
      }),
    );
    expect(await screen.findByText("正式转写已排队")).toBeVisible();
  });
});
