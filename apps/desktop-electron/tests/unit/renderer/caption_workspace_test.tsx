// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptionWorkspace } from "../../../src/renderer/features/captions/caption-workspace";
import type { CaptionSnapshot } from "../../../src/shared/contracts";

const initialDraft: NonNullable<CaptionSnapshot["draft"]> = {
  generationId: 21,
  attempt: 1,
  state: "running",
  utterances: [
    {
      sequence: 1,
      startMs: 0,
      endMs: 900,
      text: "先记录这一句。",
      language: "zh",
    },
    {
      sequence: 2,
      startMs: 900,
      endMs: 1_800,
      text: "草稿仍可能变化。",
      language: "zh",
    },
  ],
  hasEarlierUtterances: false,
  backlogBytes: 0,
  errorCode: null,
};

const initialSnapshot: CaptionSnapshot = {
  revision: 4,
  sessionId: "session-caption-renderer-123456",
  draft: initialDraft,
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
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function createCaptionBridge(snapshot: CaptionSnapshot = initialSnapshot) {
  let listener: ((value: CaptionSnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    getSnapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn((next: (value: CaptionSnapshot) => void) => {
      listener = next;
      return unsubscribe;
    }),
    retryFormal: vi.fn(async (): Promise<CaptionSnapshot> => {
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        formal: {
          generationId: 42,
          attempt: snapshot.formal.attempt + 1,
          state: "queued",
          errorCode: null,
        },
      };
    }),
    emit(value: CaptionSnapshot) {
      act(() => listener?.(value));
    },
    unsubscribe,
  };
}

describe("caption workspace", () => {
  it("shows formal-only state without inventing a SenseVoice draft", async () => {
    const formalOnly: CaptionSnapshot = {
      ...initialSnapshot,
      revision: 5,
      draft: null,
      formal: {
        generationId: 42,
        attempt: 1,
        state: "queued",
        errorCode: null,
      },
      displayAuthority: "none",
    };
    const bridge = createCaptionBridge(formalOnly);
    render(
      <CaptionWorkspace
        sessionId={formalOnly.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    expect(
      await screen.findByText("正式转写已排队 · 第 1 次尝试"),
    ).toBeVisible();
    expect(screen.queryByText("实时草稿 · 可能变化")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制字幕" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("caption-live-announcement"),
    ).toBeEmptyDOMElement();
  });

  it("restores the durable draft after reload without starting a duplicate session", async () => {
    const bridge = createCaptionBridge();
    const first = render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "实时字幕与转写" }),
    ).toHaveTextContent("先记录这一句。草稿仍可能变化。");
    first.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();

    render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );
    expect(await screen.findByText("先记录这一句。")).toBeVisible();
    expect(bridge.getSnapshot).toHaveBeenCalledTimes(2);
    expect(bridge.subscribe).toHaveBeenCalledTimes(2);
  });

  it("replaces an already rendered session when the active session changes", async () => {
    const nextSnapshot: CaptionSnapshot = {
      ...initialSnapshot,
      revision: 1,
      sessionId: "session-caption-renderer-654321",
      draft: {
        ...initialDraft,
        generationId: 22,
        utterances: [
          {
            sequence: 1,
            startMs: 0,
            endMs: 800,
            text: "新会话已经接管。",
            language: "zh",
          },
        ],
      },
    };
    const bridge = createCaptionBridge();
    bridge.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(nextSnapshot);
    const view = render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );
    expect(await screen.findByText("先记录这一句。")).toBeVisible();

    view.rerender(
      <CaptionWorkspace
        sessionId={nextSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );
    expect(await screen.findByText("新会话已经接管。")).toBeVisible();
    expect(screen.queryByText("先记录这一句。")).not.toBeInTheDocument();
  });

  it("fences a stale load and late old-attempt event when the session changes", async () => {
    const oldLoad = deferred<CaptionSnapshot>();
    const nextSnapshot: CaptionSnapshot = {
      ...initialSnapshot,
      revision: 8,
      sessionId: "session-caption-renderer-654321",
      draft: {
        ...initialDraft,
        generationId: 22,
        attempt: 2,
        utterances: [
          {
            sequence: 1,
            startMs: 0,
            endMs: 800,
            text: "新会议字幕。",
            language: "zh",
          },
        ],
      },
    };
    const bridge = createCaptionBridge(nextSnapshot);
    bridge.getSnapshot
      .mockImplementationOnce(() => oldLoad.promise)
      .mockResolvedValueOnce(nextSnapshot);
    const view = render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    view.rerender(
      <CaptionWorkspace
        sessionId={nextSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );
    expect(await screen.findByText("新会议字幕。")).toBeVisible();

    oldLoad.resolve(initialSnapshot);
    bridge.emit({
      ...nextSnapshot,
      revision: 99,
      draft: {
        ...initialDraft,
        generationId: 21,
        attempt: 1,
        utterances: [
          {
            sequence: 99,
            startMs: 98_000,
            endMs: 99_000,
            text: "旧 attempt 不得回流。",
            language: "zh",
          },
        ],
      },
    });
    await act(async () => await oldLoad.promise);
    expect(screen.queryByText("旧 attempt 不得回流。")).not.toBeInTheDocument();
    expect(screen.queryByText("先记录这一句。")).not.toBeInTheDocument();
    expect(screen.getByText("新会议字幕。")).toBeVisible();
  });

  it("throttles live announcements while keeping reading focus stable", async () => {
    vi.useFakeTimers();
    const bridge = createCaptionBridge();
    render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );
    await act(async () => await Promise.resolve());
    const readingControl = screen.getByRole("button", { name: "复制字幕" });
    readingControl.focus();

    bridge.emit({
      ...initialSnapshot,
      revision: 5,
      draft: {
        ...initialDraft,
        utterances: [
          ...initialDraft.utterances,
          {
            sequence: 3,
            startMs: 1_800,
            endMs: 2_400,
            text: "第三句。",
            language: "zh",
          },
        ],
      },
    });
    bridge.emit({
      ...initialSnapshot,
      revision: 6,
      draft: {
        ...initialDraft,
        utterances: [
          ...initialDraft.utterances,
          {
            sequence: 3,
            startMs: 1_800,
            endMs: 2_400,
            text: "第三句。",
            language: "zh",
          },
          {
            sequence: 4,
            startMs: 2_400,
            endMs: 3_000,
            text: "第四句。",
            language: "zh",
          },
        ],
      },
    });
    expect(readingControl).toHaveFocus();
    expect(
      screen.getByTestId("caption-live-announcement"),
    ).not.toHaveTextContent("第四句。");

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(screen.getByTestId("caption-live-announcement")).toHaveTextContent(
      "最新实时草稿：第四句。",
    );
    expect(readingControl).toHaveFocus();
  });

  it("exposes backlog and caption failure with text, semantics, and intact capture language", async () => {
    const bridge = createCaptionBridge({
      ...initialSnapshot,
      draft: {
        ...initialDraft,
        state: "degraded",
        backlogBytes: 700_000,
        errorCode: "CAPTION_BACKLOG_EXCEEDED",
      },
    });
    render(
      <CaptionWorkspace
        sessionId={initialSnapshot.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("实时草稿已降级");
    expect(alert).toHaveTextContent("录音继续且权威音频不受影响");
    expect(
      screen.getByRole("progressbar", { name: "实时草稿积压" }),
    ).toHaveAttribute("aria-valuetext", expect.stringContaining("积压"));
    expect(screen.getByText(/700,000 字节/)).toBeVisible();
  });

  it("labels draft, formal, and manual authority and retries formal once with a new attempt", async () => {
    const failed: CaptionSnapshot = {
      ...initialSnapshot,
      displayAuthority: "live_draft",
      formal: {
        generationId: 41,
        attempt: 2,
        state: "failed",
        errorCode: "FORMAL_WORKER_EXITED",
      },
    };
    const request = deferred<CaptionSnapshot>();
    const bridge = createCaptionBridge(failed);
    bridge.retryFormal.mockImplementation(() => request.promise);
    const user = userEvent.setup();
    render(
      <CaptionWorkspace
        sessionId={failed.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    expect(await screen.findByText("实时草稿 · 可能变化")).toBeVisible();
    expect(screen.getByText("正式转写 · Qwen3")).toBeVisible();
    expect(screen.getByText("人工修订 · 独立保留")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "正式转写失败；实时草稿仍保留且未被覆盖",
    );

    const retry = screen.getByRole("button", { name: "重试正式转写" });
    await user.dblClick(retry);
    expect(bridge.retryFormal).toHaveBeenCalledTimes(1);
    expect(bridge.retryFormal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: failed.sessionId,
        expectedAttempt: 2,
        idempotencyKey: `formal-retry-${failed.sessionId}-3`,
      }),
    );
    expect(retry).toBeDisabled();

    request.resolve({
      ...failed,
      revision: 7,
      formal: {
        generationId: 42,
        attempt: 3,
        state: "queued",
        errorCode: null,
      },
    });
    await waitFor(() =>
      expect(screen.getByText("正式转写已排队 · 第 3 次尝试")).toBeVisible(),
    );

    bridge.emit(failed);
    expect(screen.getByText("正式转写已排队 · 第 3 次尝试")).toBeVisible();
  });

  it("surfaces a temporarily unavailable formal retry and releases the pending guard", async () => {
    const failed: CaptionSnapshot = {
      ...initialSnapshot,
      formal: {
        generationId: 41,
        attempt: 2,
        state: "failed",
        errorCode: "FORMAL_WORKER_EXITED",
      },
    };
    const bridge = createCaptionBridge(failed);
    bridge.retryFormal.mockRejectedValue(
      new Error("formal transcript retry is unavailable"),
    );
    const user = userEvent.setup();
    render(
      <CaptionWorkspace
        sessionId={failed.sessionId}
        getSnapshot={bridge.getSnapshot}
        subscribe={bridge.subscribe}
        retryFormal={bridge.retryFormal}
      />,
    );

    const retry = await screen.findByRole("button", {
      name: "重试正式转写",
    });
    await user.click(retry);
    expect(
      await screen.findByText("formal transcript retry is unavailable"),
    ).toBeVisible();
    await waitFor(() => expect(retry).toBeEnabled());

    await user.click(retry);
    expect(bridge.retryFormal).toHaveBeenCalledTimes(2);
  });
});
