// @vitest-environment jsdom

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

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: { ...actual.toast, ...toastSpies },
  };
});

import {
  CaptureWorkspaceController,
  CaptureWorkspace,
  FloatingCapturePreferenceSetting,
} from "../../../src/renderer/features/capture/capture-workspace";
import {
  RECORDING_PREFERENCE_STORAGE_KEY,
  SYSTEM_DEFAULT_MICROPHONE,
  resolveRecordingMicrophone,
  useRecordingPreference,
} from "../../../src/renderer/features/capture/use-recording-preference";
import type {
  ApplicationSnapshot,
  CapturePreflight,
  CaptureRecoveryActionRequest,
  CaptureRecoveryActionResponse,
  CaptureRecoveryItem,
  CaptureSnapshot,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const idle: ApplicationSnapshot["capture"] = { phase: "idle" };
const readyPreflight: CapturePreflight = {
  minimumMacosVersion: "13.0",
  systemAudioMinimumMacosVersion: "13.0",
  captureMode: "dual_track",
  systemAudioPermission: "granted",
  microphonePermission: "granted",
  microphones: [{ id: "mic-default", name: "MacBook 麦克风", isDefault: true }],
  availableBytes: 8 * 1024 ** 3,
  requiredBytes: 2 * 1024 ** 3,
  captionModelAvailable: true,
  canStart: true,
  blockingReasons: [],
};

const recording: CaptureSnapshot = {
  sessionId: "session-capture-unit-123456",
  state: "recording",
  captureMode: "dual_track",
  captureTimelineMs: 5_000,
  systemAudioHealthy: true,
  microphoneHealthy: true,
  partialCapture: false,
  finalizedChunkCount: 1,
  eventCount: 2,
  gapCount: 0,
  interruptionReason: null,
  recordingSha256: null,
};

function recoveryItem(
  overrides: Partial<CaptureRecoveryItem> = {},
): CaptureRecoveryItem {
  return {
    ...recording,
    title: "Recover-音频录制",
    state: "recoverable",
    capability: "restorable",
    reason: null,
    ...overrides,
  };
}

function recoveryResponse(
  overrides: Partial<CaptureRecoveryActionResponse> = {},
): CaptureRecoveryActionResponse {
  return {
    outcomes: [],
    recoveries: [],
    ...overrides,
  };
}

afterEach(() => {
  window.localStorage.clear();
  toastSpies.success.mockClear();
  toastSpies.warning.mockClear();
  vi.restoreAllMocks();
});

function RecordingPreferenceProbe() {
  const preference = useRecordingPreference();
  return (
    <div>
      <output>{preference.microphoneDeviceId}</output>
      <output>{preference.error ?? "ok"}</output>
      <button
        type="button"
        onClick={() => preference.setMicrophone("mic-usb", "USB 麦克风")}
      >
        保存麦克风
      </button>
    </div>
  );
}

function installCaptureApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  const api = {
    preflightCapture: vi.fn(async () => readyPreflight),
    startCapture: vi.fn(async () => recording),
    controlCapture: vi.fn(async () => recording),
    suggestCaptureTitle: vi.fn(async () => ({ title: "新录音2026090501" })),
    renameCaptureSession: vi.fn(async () => ({
      protocolVersion: 2,
      revision: 2,
      navigation: { section: "library" as const },
      profile: { phase: "ready" as const, legacyDatabaseArchived: false },
      connectivity: "online" as const,
      capability: { processing: "available" as const },
      library: { phase: "empty" as const },
      reconciliation: [],
      capture: { phase: "idle" as const },
    })),
    listCaptureRecoveries: vi.fn(async () => []),
    actOnCaptureRecovery: vi.fn(async () => recoveryResponse()),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    onCaptionSnapshot: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return api;
}

function renderCaptureProjection(capture: ApplicationSnapshot["capture"]) {
  return render(
    <CaptureWorkspaceController capture={capture}>
      {({ customTitle, content, footer }) => (
        <>
          <header>{customTitle}</header>
          <main>{content}</main>
          <aside data-testid="footer-slot">{footer}</aside>
        </>
      )}
    </CaptureWorkspaceController>,
  );
}

describe("capture workspace", () => {
  it.each([
    ["preparing", "正在开始录制", "暂停录制", true, "停止并保存", true],
    ["recording", "正在录制", "暂停录制", false, "停止并保存", false],
    ["paused", "录制已暂停", "继续录制", false, "停止并保存", false],
    [
      "wake",
      "等待你确认继续录制",
      "确认并继续录制",
      false,
      "停止并保存",
      false,
    ],
    ["partial", "部分录制", "暂停录制", false, "停止并保存", false],
    ["finalizing", "正在保存录音…", "暂停录制", true, "停止并保存", true],
  ])(
    "projects the %s footer row with only its legal controls",
    (_, status, primaryAction, primaryDisabled, stopAction, stopDisabled) => {
      installCaptureApi();
      const captureByCase = {
        preparing: {
          phase: "preparing",
          sessionId: recording.sessionId,
          title: "准备录制",
          elapsedMs: 0,
          audioActivity: 0.8,
        },
        recording: {
          phase: "recording",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
          audioActivity: 0.8,
        },
        paused: {
          phase: "paused",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
          audioActivity: 0.8,
        },
        wake: {
          phase: "paused",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
          audioActivity: 0.8,
          interruptionReason: "system_wake_requires_resume",
        },
        partial: {
          phase: "partial_capture",
          sessionId: recording.sessionId,
          title: "部分录制",
          elapsedMs: 5_000,
          audioActivity: 0.6,
          systemAudioHealthy: true,
          microphoneHealthy: false,
          partialCapture: true,
        },
        finalizing: {
          phase: "finalizing",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
          audioActivity: 0.8,
        },
      } satisfies Record<string, ApplicationSnapshot["capture"]>;
      renderCaptureProjection(captureByCase[_ as keyof typeof captureByCase]);

      const footer = screen.getByTestId("footer-slot");
      expect(within(footer).getByText(status)).toBeVisible();
      expect(
        within(footer).getByText(_ === "preparing" ? "00:00" : "00:05"),
      ).toHaveClass("tabular-nums");
      expect(
        within(footer).getByRole("button", { name: primaryAction }),
      ).toHaveProperty("disabled", primaryDisabled);
      expect(
        within(footer).getByRole("button", { name: stopAction }),
      ).toHaveProperty("disabled", stopDisabled);
    },
  );

  it("shows the slow-save snapshot state without offering another stop", () => {
    installCaptureApi();
    renderCaptureProjection({
      phase: "finalizing",
      sessionId: recording.sessionId,
      title: "访谈录制",
      elapsedMs: 20_000,
      audioActivity: 0,
      interruptionReason: "capture_stop_slow",
      message: "保存时间比预期长，仍在继续保存…",
    });

    const footer = screen.getByTestId("footer-slot");
    expect(
      within(footer).getByText("保存时间比预期长，仍在继续保存…"),
    ).toBeVisible();
    expect(
      within(footer).getByRole("button", { name: "停止并保存" }),
    ).toBeDisabled();
    expect(screen.getAllByText("保存时间比预期长，仍在继续保存…")).toHaveLength(
      1,
    );
  });

  it.each([
    ["completed", "录制已保存"],
    ["failed", "录制需要处理"],
    ["partial_capture", "部分录制已保存"],
  ] as const)(
    "projects the %s terminal footer without recording controls",
    (phase, status) => {
      installCaptureApi();
      renderCaptureProjection({
        phase,
        sessionId: recording.sessionId,
        title: "访谈录制",
        elapsedMs: 65_000,
        ...(phase === "partial_capture"
          ? { systemAudioHealthy: false, microphoneHealthy: false }
          : {}),
      });

      const footer = screen.getByTestId("footer-slot");
      expect(within(footer).getByText(status)).toBeVisible();
      expect(within(footer).getByText("01:05")).toBeVisible();
      expect(
        within(footer).queryByRole("button", { name: /暂停|继续|停止/ }),
      ).toBeNull();
    },
  );

  it("does not render an audio activity waveform in the footer", () => {
    installCaptureApi();
    renderCaptureProjection({
      phase: "recording",
      sessionId: "session-one",
      title: "访谈录制",
      elapsedMs: 5_000,
      audioActivity: 0.1,
    });

    expect(screen.queryByLabelText("录音活动")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("capture-activity-sample")).toHaveLength(0);
  });

  it("does not project a footer before a session exists", () => {
    installCaptureApi();
    renderCaptureProjection(idle);
    expect(screen.getByTestId("footer-slot")).toBeEmptyDOMElement();
  });

  it("starts automatically after the suggested title resolves", async () => {
    let resolveSuggestion!: (value: { title: string }) => void;
    const suggestCaptureTitle = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ title: string }>((resolve) => {
            resolveSuggestion = resolve;
          }),
      )
      .mockResolvedValue({ title: "新录音2026090507" });
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ suggestCaptureTitle, startCapture });
    const user = userEvent.setup();
    render(
      <CaptureWorkspaceController capture={idle}>
        {({ customTitle, content, footer }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
            {footer}
          </>
        )}
      </CaptureWorkspaceController>,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    expect(screen.queryByRole("button", { name: "编辑录制名称" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始录制" })).toBeNull();

    resolveSuggestion({ title: "新录音2026090507" });
    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "新录音2026090507",
          refreshSuggestedTitle: true,
          captionEnabled: true,
        }),
      ),
    );
  });

  it("does not interrupt one-click start with pre-recording title editing", async () => {
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ startCapture });
    const user = userEvent.setup();
    renderCaptureProjection(idle);

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "新录音2026090501",
          refreshSuggestedTitle: true,
        }),
      ),
    );
    expect(screen.queryByRole("button", { name: "编辑录制名称" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "录制名称" })).toBeNull();
  });

  it("edits a surface-free active title and saves a non-composing Enter once", async () => {
    let resolveRename!: (value: unknown) => void;
    const renameCaptureSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRename = resolve;
        }),
    ) as unknown as Voice2TextDesktopApi["renameCaptureSession"];
    installCaptureApi({ renameCaptureSession });
    const user = userEvent.setup();
    render(
      <CaptureWorkspaceController
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "客户访谈",
          elapsedMs: 5_000,
        }}
      >
        {({ customTitle, content, footer }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
            {footer}
          </>
        )}
      </CaptureWorkspaceController>,
    );

    const titleButton = await screen.findByRole("button", { name: "客户访谈" });
    expect(titleButton).toHaveAttribute("data-variant", "text");
    expect(titleButton).toHaveClass("cursor-text");
    expect(titleButton.className).not.toContain("hover:");
    expect(titleButton.querySelector("svg")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "编辑录制名称" }),
    ).not.toBeInTheDocument();
    await user.click(titleButton);
    const input = screen.getByRole("textbox", { name: "录制名称" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", "50");
    expect(input).toHaveClass("min-w-[180px]");
    await user.clear(input);
    await user.type(input, "  产品回访  ");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveFocus();
    expect(renameCaptureSession).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(renameCaptureSession).toHaveBeenCalledOnce();
    expect(renameCaptureSession).toHaveBeenCalledWith({
      sessionId: recording.sessionId,
      title: "产品回访",
    });
    fireEvent.blur(input);
    expect(renameCaptureSession).toHaveBeenCalledOnce();
    resolveRename({ capture: { ...idle } });
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(screen.queryByText("跨页面持续运行，由本机安全保存。")).toBeNull();
    expect(screen.queryByLabelText("录制名称")).toBeNull();
  });

  it("saves an active title on blur only once", async () => {
    const renameCaptureSession = vi.fn(async () => ({
      capture: { ...idle },
    })) as unknown as Voice2TextDesktopApi["renameCaptureSession"];
    installCaptureApi({ renameCaptureSession });
    const user = userEvent.setup();
    renderCaptureProjection({
      phase: "recording",
      sessionId: recording.sessionId,
      title: "客户访谈",
      elapsedMs: 5_000,
    });

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const input = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(input);
    await user.type(input, "复盘访谈");
    fireEvent.blur(input);
    fireEvent.blur(input);

    await waitFor(() => expect(renameCaptureSession).toHaveBeenCalledOnce());
    expect(renameCaptureSession).toHaveBeenCalledWith({
      sessionId: recording.sessionId,
      title: "复盘访谈",
    });
  });

  it("keeps invalid capture-title correction in one prefilled input dialog", async () => {
    installCaptureApi();
    const user = userEvent.setup();
    renderCaptureProjection({
      phase: "recording",
      sessionId: recording.sessionId,
      title: "客户访谈",
      elapsedMs: 5_000,
    });

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const editor = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(editor);
    fireEvent.blur(editor);

    const dialog = await screen.findByRole("dialog", {
      name: "请检查录制名称",
    });
    const correction = within(dialog).getByRole("textbox", {
      name: "录制名称",
    });
    expect(correction).toHaveValue("");
    await user.type(correction, "访".repeat(51));
    await user.click(within(dialog).getByRole("button", { name: "保存名称" }));
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent("录制名称最多包含 50 个字符。");
  });

  it("keeps terminal titles read-only", async () => {
    installCaptureApi();
    render(
      <CaptureWorkspaceController
        capture={{
          phase: "finalizing",
          sessionId: recording.sessionId,
          title: "季度访谈",
          elapsedMs: 5_000,
        }}
      >
        {({ customTitle }) => <header>{customTitle}</header>}
      </CaptureWorkspaceController>,
    );

    expect(
      await screen.findByRole("heading", { name: "季度访谈" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "编辑录制名称" })).toBeNull();
    expect(screen.queryByRole("button", { name: "季度访谈" })).toBeNull();
  });

  it("cancels a dirty stop intent when rename fails and offers a local retry", async () => {
    const renameCaptureSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValue({ capture: idle });
    installCaptureApi({
      renameCaptureSession:
        renameCaptureSession as unknown as Voice2TextDesktopApi["renameCaptureSession"],
    });
    const user = userEvent.setup();
    render(
      <CaptureWorkspaceController
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "客户访谈",
          elapsedMs: 5_000,
        }}
      >
        {({ customTitle, content, footer }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
            {footer}
          </>
        )}
      </CaptureWorkspaceController>,
    );

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const input = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(input);
    await user.type(input, "客户回访");
    await user.click(screen.getByRole("button", { name: "停止并保存" }));

    expect(
      await screen.findByRole("dialog", { name: "录制名称未保存" }),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog", { name: "提示" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(renameCaptureSession).toHaveBeenCalledTimes(2));
  });

  it("saves the latest draft before stop when an earlier rename is pending", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const renameCaptureSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    installCaptureApi({
      renameCaptureSession:
        renameCaptureSession as unknown as Voice2TextDesktopApi["renameCaptureSession"],
    });
    const user = userEvent.setup();
    renderCaptureProjection({
      phase: "recording",
      sessionId: recording.sessionId,
      title: "客户访谈",
      elapsedMs: 5_000,
    });

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const input = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(input);
    await user.type(input, "草稿 A");
    fireEvent.blur(input);
    await waitFor(() => expect(renameCaptureSession).toHaveBeenCalledTimes(1));

    await user.clear(input);
    await user.type(input, "草稿 B");
    await user.click(screen.getByRole("button", { name: "停止并保存" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    resolveFirst({ capture: idle });
    await waitFor(() =>
      expect(renameCaptureSession).toHaveBeenNthCalledWith(2, {
        sessionId: recording.sessionId,
        title: "草稿 B",
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    resolveSecond({ capture: idle });
    expect(
      await screen.findByRole("alertdialog", { name: "提示" }),
    ).toBeVisible();
  });

  it("saves the latest draft before stop when the earlier rename fails", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const renameCaptureSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    installCaptureApi({
      renameCaptureSession:
        renameCaptureSession as unknown as Voice2TextDesktopApi["renameCaptureSession"],
    });
    const user = userEvent.setup();
    renderCaptureProjection({
      phase: "recording",
      sessionId: recording.sessionId,
      title: "客户访谈",
      elapsedMs: 5_000,
    });

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const input = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(input);
    await user.type(input, "草稿 A");
    fireEvent.blur(input);
    await waitFor(() => expect(renameCaptureSession).toHaveBeenCalledTimes(1));

    await user.clear(input);
    await user.type(input, "草稿 B");
    await user.click(screen.getByRole("button", { name: "停止并保存" }));
    rejectFirst(new Error("database busy"));

    await waitFor(() =>
      expect(renameCaptureSession).toHaveBeenNthCalledWith(2, {
        sessionId: recording.sessionId,
        title: "草稿 B",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "录制名称未保存" })).toBeNull();

    resolveSecond({ capture: idle });
    expect(
      await screen.findByRole("alertdialog", { name: "提示" }),
    ).toBeVisible();
  });

  it("shows the focused recovery only in the recovery dialog", async () => {
    const focusedRecovery: CaptureRecoveryItem = {
      ...recording,
      sessionId: "session-recovery-focused-123456",
      title: `Recover-${"访".repeat(50)}`,
      state: "recoverable",
      capability: "restorable",
      reason: null,
      captureTimelineMs: 15_000,
      interruptionReason: "renderer_reloaded",
    };
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [focusedRecovery]),
    });
    render(
      <CaptureWorkspaceController
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "其他活动录制",
          elapsedMs: 5_000,
        }}
        focusSessionId={focusedRecovery.sessionId}
      >
        {({ customTitle, content, footer }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
            {footer}
          </>
        )}
      </CaptureWorkspaceController>,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "发现可恢复的录音",
    });
    expect(within(dialog).getByText(/发现 1 段可恢复录音/)).toBeVisible();
    expect(within(dialog).queryByText(focusedRecovery.title)).toBeNull();
    expect(screen.queryByText("其他活动录制")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "录制名称" })).toBeNull();
    expect(screen.queryByTestId("footer-slot")).toBeNull();
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();
  });

  it("opens retry detail when title suggestion fails", async () => {
    const onDetailOpenChange = vi.fn();
    installCaptureApi({
      suggestCaptureTitle: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const view = render(
      <CaptureWorkspaceController
        capture={idle}
        detailOpen={false}
        recordRequest={0}
        onDetailOpenChange={onDetailOpenChange}
      >
        {({ customTitle, content }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
          </>
        )}
      </CaptureWorkspaceController>,
    );

    view.rerender(
      <CaptureWorkspaceController
        capture={idle}
        detailOpen={false}
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
      >
        {({ customTitle, content }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
          </>
        )}
      </CaptureWorkspaceController>,
    );
    await waitFor(() => expect(onDetailOpenChange).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();

    view.rerender(
      <CaptureWorkspaceController
        capture={idle}
        detailOpen
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
      >
        {({ customTitle, content }) => (
          <>
            <header>{customTitle}</header>
            <main>{content}</main>
          </>
        )}
      </CaptureWorkspaceController>,
    );
    const errorDialog = await screen.findByRole("dialog", {
      name: "录制遇到问题",
    });
    expect(errorDialog).toHaveTextContent("无法开始录制");
    await userEvent
      .setup()
      .click(within(errorDialog).getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("button", { name: "重试开始录制" })).toBeEnabled();
    expect(
      screen.queryByRole("dialog", { name: "无法准备录制名称" }),
    ).toBeNull();
  });
  it("resolves the saved microphone with deterministic default and first-device fallbacks", () => {
    const microphones = [
      { id: "mic-first", name: "外接麦克风", isDefault: false },
      { id: "mic-default", name: "系统麦克风", isDefault: true },
    ];

    expect(
      resolveRecordingMicrophone(microphones, SYSTEM_DEFAULT_MICROPHONE)?.id,
    ).toBe("mic-default");
    expect(
      resolveRecordingMicrophone(
        microphones.map((device) => ({ ...device, isDefault: false })),
        SYSTEM_DEFAULT_MICROPHONE,
      )?.id,
    ).toBe("mic-first");
    expect(resolveRecordingMicrophone(microphones, "mic-first")?.id).toBe(
      "mic-first",
    );
    expect(resolveRecordingMicrophone(microphones, "mic-missing")?.id).toBe(
      "mic-default",
    );
    expect(
      resolveRecordingMicrophone(
        [
          ...microphones,
          {
            id: "mic-missing",
            name: "已恢复的会议麦克风",
            isDefault: false,
          },
        ],
        "mic-missing",
      )?.id,
    ).toBe("mic-missing");
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "an unknown version",
      JSON.stringify({
        version: 2,
        microphoneDeviceId: "mic-usb",
        microphoneName: "USB 麦克风",
      }),
    ],
  ])("falls back safely for %s", (_, stored) => {
    window.localStorage.setItem(RECORDING_PREFERENCE_STORAGE_KEY, stored);

    render(<RecordingPreferenceProbe />);

    expect(screen.getByText(SYSTEM_DEFAULT_MICROPHONE)).toBeVisible();
    expect(screen.getByText("read-failed")).toBeVisible();
  });

  it("persists a selected microphone across consumer remounts", async () => {
    const first = render(<RecordingPreferenceProbe />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "保存麦克风" }));
    expect(screen.getByText("mic-usb")).toBeVisible();
    expect(screen.getByText("ok")).toBeVisible();
    first.unmount();

    render(<RecordingPreferenceProbe />);

    expect(screen.getByText("mic-usb")).toBeVisible();
    expect(screen.getByText("ok")).toBeVisible();
  });

  it("keeps preference reads and writes usable with stable storage errors", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });
    const view = render(<RecordingPreferenceProbe />);

    expect(screen.getByText(SYSTEM_DEFAULT_MICROPHONE)).toBeVisible();
    expect(screen.getByText("read-failed")).toBeVisible();

    getItem.mockRestore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "保存麦克风" }));

    expect(screen.getByText("mic-usb")).toBeVisible();
    expect(screen.getByText("write-failed")).toBeVisible();
    view.unmount();
  });

  it("uses a persisted microphone for formal recording", async () => {
    window.localStorage.setItem(
      RECORDING_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        microphoneDeviceId: "mic-usb",
        microphoneName: "USB 麦克风",
      }),
    );
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({
      preflightCapture: vi.fn(async () => ({
        ...readyPreflight,
        microphones: [
          ...readyPreflight.microphones,
          { id: "mic-usb", name: "USB 麦克风", isDefault: false },
        ],
      })),
      startCapture,
    });
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({ microphoneDeviceId: "mic-usb" }),
      ),
    );
  });

  it("falls back without clearing a temporarily missing persisted microphone", async () => {
    const storedPreference = JSON.stringify({
      version: 1,
      microphoneDeviceId: "mic-disconnected",
      microphoneName: "会议麦克风",
    });
    window.localStorage.setItem(
      RECORDING_PREFERENCE_STORAGE_KEY,
      storedPreference,
    );
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ startCapture });
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({ microphoneDeviceId: "mic-default" }),
      ),
    );
    expect(window.localStorage.getItem(RECORDING_PREFERENCE_STORAGE_KEY)).toBe(
      storedPreference,
    );
  });

  it("keeps the floating preference controlled while pending and rolls back on failure", async () => {
    let rejectPreference!: (reason?: unknown) => void;
    const preferenceUpdate = new Promise<{ enabled: boolean }>((_, reject) => {
      rejectPreference = reject;
    });
    const setFloatingCapturePreference = vi.fn(() => preferenceUpdate);
    installCaptureApi({
      getFloatingCapturePreference: vi.fn(async () => ({ enabled: false })),
      setFloatingCapturePreference,
    });
    const user = userEvent.setup();

    render(<FloatingCapturePreferenceSetting />);
    const toggle = await screen.findByRole("switch", {
      name: "悬浮控制条",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(setFloatingCapturePreference).toHaveBeenCalledWith(true);
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();

    rejectPreference(new Error("设置保存失败"));
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("设置未保存，请重试。")).toBeVisible();
  });

  it.each([
    "microphone_permission_denied",
    "system_audio_runtime_unsupported",
    "microphone_device_missing",
    "disk_space_low",
    "caption_model_unavailable",
  ])(
    "surfaces only an actionable retry for blocking reason %s",
    async (reason) => {
      installCaptureApi({
        preflightCapture: vi.fn(async () => ({
          ...readyPreflight,
          microphones:
            reason === "microphone_device_missing"
              ? []
              : readyPreflight.microphones,
          canStart: false,
          blockingReasons: [reason],
        })),
      });
      const user = userEvent.setup();
      const onPreflightResolved = vi.fn();
      render(
        <CaptureWorkspace
          capture={idle}
          applicationRevision={1}
          onPreflightResolved={onPreflightResolved}
        />,
      );

      await user.click(screen.getByRole("button", { name: "开始录制" }));
      await waitFor(() => expect(onPreflightResolved).toHaveBeenCalledOnce());
      const errorDialog = await screen.findByRole("dialog", {
        name: "录制遇到问题",
      });
      expect(errorDialog).toHaveTextContent("无法开始录制");
      await user.click(
        within(errorDialog).getByRole("button", { name: "知道了" }),
      );
      expect(
        screen.queryByRole("heading", { name: "设置音频录制" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("录制条件需要处理")).not.toBeInTheDocument();
      expect(screen.queryByText("可使用降级录制")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "麦克风" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "重新检查录制条件" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "重试开始录制" }),
      ).toBeEnabled();
    },
  );

  it("keeps recording available when the optional caption model is unavailable", async () => {
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({
      preflightCapture: vi.fn(async () => ({
        ...readyPreflight,
        captionModelAvailable: false,
        canStart: true,
        blockingReasons: ["caption_model_unavailable"],
      })),
      startCapture,
    });
    const user = userEvent.setup();
    const onPreflightResolved = vi.fn();
    render(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        onPreflightResolved={onPreflightResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(onPreflightResolved).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({ captionEnabled: false }),
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "设置音频录制" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("实时字幕模型未安装，本次仍可正常录音。"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "前往本地模型" }),
    ).not.toBeInTheDocument();
  });

  it("does not show degraded-recording guidance after entering setup", async () => {
    const api = installCaptureApi({
      preflightCapture: vi.fn(async () => ({
        ...readyPreflight,
        captureMode: "system_audio_only" as const,
        microphonePermission: "denied" as const,
        microphones: [],
        canStart: true,
        blockingReasons: ["microphone_permission_denied"],
      })),
    });
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(api.preflightCapture).toHaveBeenCalledOnce());
    const errorDialog = await screen.findByRole("dialog", {
      name: "录制遇到问题",
    });
    await user.click(
      within(errorDialog).getByRole("button", { name: "知道了" }),
    );
    expect(
      screen.queryByRole("heading", { name: "设置音频录制" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("麦克风权限被拒绝")).not.toBeInTheDocument();
    expect(screen.queryByText("可使用降级录制")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试开始录制" })).toBeEnabled();
  });

  it("retries the complete one-click flow after native capture start fails", async () => {
    const startCapture = vi
      .fn()
      .mockRejectedValueOnce(new Error("录制设备暂时不可用"))
      .mockResolvedValueOnce(recording);
    const api = installCaptureApi({ startCapture });
    const user = userEvent.setup();
    const onDetailOpenChange = vi.fn();
    const view = render(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        detailOpen={false}
        recordRequest={0}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );

    view.rerender(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        detailOpen={false}
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );
    await waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();
    expect(onDetailOpenChange).toHaveBeenCalledWith(true);

    view.rerender(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        detailOpen
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );
    const errorDialog = await screen.findByRole("dialog", {
      name: "录制遇到问题",
    });
    expect(errorDialog).toHaveTextContent("无法开始录制");
    await user.click(
      within(errorDialog).getByRole("button", { name: "知道了" }),
    );

    await user.click(screen.getByRole("button", { name: "重试开始录制" }));
    await waitFor(() => expect(startCapture).toHaveBeenCalledTimes(2));
    expect(api.preflightCapture).toHaveBeenCalledTimes(2);
    expect(api.suggestCaptureTitle).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued one-click start when capture enters recovery", async () => {
    let resolveSuggestion!: (value: { title: string }) => void;
    const suggestCaptureTitle = vi.fn(
      () =>
        new Promise<{ title: string }>((resolve) => {
          resolveSuggestion = resolve;
        }),
    );
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ suggestCaptureTitle, startCapture });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={1} />,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(suggestCaptureTitle).toHaveBeenCalledOnce());
    view.rerender(
      <CaptureWorkspace
        applicationRevision={2}
        capture={{
          phase: "recovery",
          sessionId: "session-recovery-queued-start",
          title: "待恢复录音",
          elapsedMs: 1_000,
        }}
      />,
    );

    await act(async () => {
      resolveSuggestion({ title: "不应启动的录音" });
    });
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("suppresses a stale start failure after capture enters recovery", async () => {
    let rejectStart!: (reason: Error) => void;
    const startCapture = vi.fn(
      () =>
        new Promise<CaptureSnapshot>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    installCaptureApi({ startCapture });
    const onDetailOpenChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    view.rerender(
      <CaptureWorkspace
        applicationRevision={2}
        capture={{
          phase: "recovery",
          sessionId: "session-recovery-stale-failure",
          title: "待恢复录音",
          elapsedMs: 1_000,
        }}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );

    await act(async () => {
      rejectStart(new Error("stale start failure"));
    });
    expect(onDetailOpenChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByText("无法开始录制")).toBeNull();
  });

  it("cancels a queued one-click start when the workspace unmounts", async () => {
    let resolveSuggestion!: (value: { title: string }) => void;
    const suggestCaptureTitle = vi.fn(
      () =>
        new Promise<{ title: string }>((resolve) => {
          resolveSuggestion = resolve;
        }),
    );
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ suggestCaptureTitle, startCapture });
    const onStartPendingChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace
        capture={idle}
        applicationRevision={1}
        onStartPendingChange={onStartPendingChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(suggestCaptureTitle).toHaveBeenCalledOnce());
    view.unmount();
    expect(onStartPendingChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      resolveSuggestion({ title: "不应启动的录音" });
    });
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("starts once on repeated activation and keeps pending state visible", async () => {
    let resolveStart!: (value: CaptureSnapshot) => void;
    const startCapture = vi.fn(
      () =>
        new Promise<CaptureSnapshot>((resolve) => {
          resolveStart = resolve;
        }),
    );
    installCaptureApi({ startCapture });
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={1} />,
    );

    const start = screen.getByRole("button", { name: "开始录制" });
    fireEvent.click(start);
    fireEvent.click(start);
    const workspace = await screen.findByRole("region", { name: "录制详情" });
    expect(workspace).not.toHaveAttribute("data-slot", "card");
    expect(workspace).not.toHaveClass("fixed", "shadow-lg");
    await waitFor(() => expect(startCapture).toHaveBeenCalledTimes(1));
    expect(screen.getByText("正在开始录制")).toBeVisible();

    resolveStart(recording);
    await waitFor(() =>
      expect(screen.queryByText("录制已经开始")).not.toBeInTheDocument(),
    );
    view.rerender(
      <CaptureWorkspace
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "音频录制",
          elapsedMs: recording.captureTimelineMs,
        }}
      />,
    );
    expect(await screen.findByText("正在录制")).toBeVisible();
  });

  it("keeps preflight on the current page and opens capture detail after start", async () => {
    let resolveStart!: (value: CaptureSnapshot) => void;
    const startCapture = vi.fn(
      () =>
        new Promise<CaptureSnapshot>((resolve) => {
          resolveStart = resolve;
        }),
    );
    installCaptureApi({ startCapture });
    const onDetailOpenChange = vi.fn();
    const onStartPendingChange = vi.fn();
    const view = render(
      <CaptureWorkspaceController
        capture={idle}
        detailOpen={false}
        recordRequest={0}
        onDetailOpenChange={onDetailOpenChange}
        onStartPendingChange={onStartPendingChange}
      >
        {({ content }) => <main>{content}</main>}
      </CaptureWorkspaceController>,
    );

    view.rerender(
      <CaptureWorkspaceController
        capture={idle}
        detailOpen={false}
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
        onStartPendingChange={onStartPendingChange}
      >
        {({ content }) => <main>{content}</main>}
      </CaptureWorkspaceController>,
    );
    await waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    expect(onStartPendingChange).toHaveBeenCalledWith(true);
    expect(onDetailOpenChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();

    await act(async () => {
      resolveStart(recording);
    });
    expect(onStartPendingChange).toHaveBeenLastCalledWith(false);
    expect(onDetailOpenChange).not.toHaveBeenCalledWith(true);

    view.rerender(
      <CaptureWorkspaceController
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "音频录制",
          elapsedMs: recording.captureTimelineMs,
        }}
        detailOpen
        recordRequest={1}
        onDetailOpenChange={onDetailOpenChange}
        onStartPendingChange={onStartPendingChange}
      >
        {({ content }) => <main>{content}</main>}
      </CaptureWorkspaceController>,
    );
    expect(
      await screen.findByRole("region", { name: "录制详情" }),
    ).toBeVisible();
  });

  it("starts directly from the primary record action after completion", async () => {
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ startCapture });
    const view = render(
      <CaptureWorkspace
        capture={{
          phase: "completed",
          sessionId: recording.sessionId,
          title: "已完成录制",
          elapsedMs: recording.captureTimelineMs,
        }}
        recordRequest={0}
      />,
    );

    view.rerender(
      <CaptureWorkspace
        capture={{
          phase: "completed",
          sessionId: recording.sessionId,
          title: "已完成录制",
          elapsedMs: recording.captureTimelineMs,
        }}
        recordRequest={1}
      />,
    );

    await waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "设置音频录制" }),
    ).not.toBeInTheDocument();
  });

  it("starts with the default microphone without showing a selector", async () => {
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({
      preflightCapture: vi.fn(async () => ({
        ...readyPreflight,
        microphones: [
          ...readyPreflight.microphones,
          { id: "mic-usb", name: "USB 麦克风", isDefault: false },
        ],
      })),
      startCapture,
    });
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    expect(
      screen.queryByRole("combobox", { name: "麦克风" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({ microphoneDeviceId: "mic-default" }),
      ),
    );
  });

  it("omits the redundant local-recording header and back action", async () => {
    installCaptureApi();
    render(
      <CaptureWorkspace
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: recording.captureTimelineMs,
        }}
        onDetailOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("region", { name: "录制详情" });
    expect(screen.queryByText("本机录制")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "返回" }),
    ).not.toBeInTheDocument();
  });

  it("cancels stop without a command, then guards confirmation until terminal state", async () => {
    let resolveStop!: (value: CaptureSnapshot) => void;
    const completed: CaptureSnapshot = {
      ...recording,
      state: "completed",
      recordingSha256: "a".repeat(64),
    };
    const controlCapture = vi.fn(
      () =>
        new Promise<CaptureSnapshot>((resolve) => {
          resolveStop = resolve;
        }),
    );
    installCaptureApi({ controlCapture });
    const view = render(
      <CaptureWorkspace
        applicationRevision={1}
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
        }}
      />,
    );

    const stop = await screen.findByRole("button", { name: "停止并保存" });
    fireEvent.click(stop);
    const dialog = screen.getByRole("alertdialog", { name: "提示" });
    expect(
      within(dialog).getByRole("heading", { name: "提示" }),
    ).toBeVisible();
    expect(dialog).toHaveTextContent("停止录制后，当前内容将自动保存。");
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    expect(
      dialog.querySelector('[data-slot="alert-dialog-footer"]'),
    ).toHaveClass("border-t", "bg-muted/50");
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const firstConfirm = within(dialog).getByRole("button", { name: "确定" });
    expect(firstConfirm).toHaveAttribute("data-variant", "default");
    expect(firstConfirm.querySelector("svg")).toBeNull();
    await waitFor(() => expect(cancel).toHaveFocus());
    const overlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]',
    );
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    expect(screen.getByRole("alertdialog", { name: "提示" })).toBeVisible();
    fireEvent.click(cancel);
    expect(controlCapture).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(stop);
    const confirm = screen.getByRole("button", { name: "确定" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(controlCapture).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();

    resolveStop(completed);
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "停止并保存" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止并保存" }));
    expect(controlCapture).toHaveBeenCalledTimes(1);
    view.rerender(
      <CaptureWorkspace
        capture={{
          phase: "completed",
          sessionId: completed.sessionId,
          title: "访谈录制",
          elapsedMs: completed.captureTimelineMs,
        }}
      />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await screen.findByText("录制已保存")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "录制另一个音频" }),
      ).toHaveFocus(),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "录制另一个音频" }));
    await waitFor(() =>
      expect(window.voice2text.startCapture).toHaveBeenCalled(),
    );
    expect(
      screen.queryByRole("heading", { name: "设置音频录制" }),
    ).not.toBeInTheDocument();
    expect(window.voice2text.preflightCapture).toHaveBeenCalledWith({
      requestPermissions: true,
      captionEnabled: true,
    });
  });

  it("moves a failed stop into a modal before allowing a retry", async () => {
    const controlCapture = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("native helper failed at /private/capture/session.json"),
      )
      .mockResolvedValueOnce(recording);
    installCaptureApi({ controlCapture });
    render(
      <CaptureWorkspace
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "停止并保存" }));
    const confirm = screen.getByRole("button", { name: "确定" });
    fireEvent.click(confirm);

    const errorDialog = await screen.findByRole("dialog", {
      name: "录制遇到问题",
    });
    expect(errorDialog).toHaveTextContent(
      "停止录制未完成，请重试；如需退出，可保留录音数据并在下次启动时恢复。",
    );
    expect(screen.queryByText(/native helper|private\/capture/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(
      within(errorDialog).getByRole("button", { name: "知道了" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "停止并保存" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(controlCapture).toHaveBeenCalledTimes(2);
  });

  it.each(["completed", "recovery"] as const)(
    "clears a failed stop after a later %s snapshot",
    async (phase) => {
      const controlCapture = vi
        .fn()
        .mockRejectedValue(
          new Error("native helper failed at /private/capture/session.json"),
        );
      installCaptureApi({ controlCapture });
      const view = render(
        <CaptureWorkspace
          capture={{
            phase: "recording",
            sessionId: recording.sessionId,
            title: "访谈录制",
            elapsedMs: 5_000,
          }}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "停止并保存" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "确定" }));
      expect(
        await screen.findByRole("dialog", { name: "录制遇到问题" }),
      ).toHaveTextContent("停止录制未完成");

      view.rerender(
        <CaptureWorkspace
          capture={{
            phase,
            sessionId: recording.sessionId,
            title: "访谈录制",
            elapsedMs: 5_000,
          }}
        />,
      );

      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "录制遇到问题" }),
        ).toBeNull(),
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    },
  );

  it("pauses once and renders the returned state", async () => {
    const paused: CaptureSnapshot = { ...recording, state: "paused" };
    const controlCapture = vi.fn(async () => paused);
    installCaptureApi({ controlCapture });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace
        applicationRevision={1}
        capture={{
          phase: "recording",
          sessionId: recording.sessionId,
          title: "键盘录制",
          elapsedMs: 5_000,
        }}
      />,
    );

    const pause = screen.getByRole("button", { name: "暂停录制" });
    await user.click(pause);
    expect(controlCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pause",
        sessionId: recording.sessionId,
      }),
    );
    view.rerender(
      <CaptureWorkspace
        capture={{
          phase: "paused",
          sessionId: paused.sessionId,
          title: "键盘录制",
          elapsedMs: paused.captureTimelineMs,
        }}
      />,
    );
    expect(await screen.findByText("录制已暂停")).toBeVisible();
  });

  it("shows partial-track gaps and requires an explicit resume after wake", async () => {
    const controlCapture = vi.fn(async () => recording);
    installCaptureApi({ controlCapture });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace
        applicationRevision={2}
        capture={{
          phase: "partial_capture",
          sessionId: recording.sessionId,
          title: "故障录制",
          elapsedMs: 18_000,
          partialCapture: true,
          systemAudioHealthy: true,
          microphoneHealthy: false,
          gapCount: 2,
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("麦克风轨道已中断");
    expect(screen.getByRole("alert")).toHaveTextContent("2 个时间缺口");
    expect(screen.getByText("系统音频轨道仍在安全录制")).toBeVisible();

    view.rerender(
      <CaptureWorkspace
        applicationRevision={3}
        capture={{
          phase: "paused",
          sessionId: recording.sessionId,
          title: "故障录制",
          elapsedMs: 20_000,
          interruptionReason: "system_sleep",
          message: "电脑已进入睡眠，录制已安全暂停。",
        }}
      />,
    );
    expect(screen.getByText("录制已暂停")).toBeVisible();
    expect(screen.getByText("电脑已进入睡眠，录制已安全暂停。")).toBeVisible();

    view.rerender(
      <CaptureWorkspace
        applicationRevision={4}
        capture={{
          phase: "paused",
          sessionId: recording.sessionId,
          title: "故障录制",
          elapsedMs: 20_000,
          interruptionReason: "system_wake_requires_resume",
          message: "电脑已唤醒，请确认后手动继续录制。",
        }}
      />,
    );
    const resume = screen.getByRole("button", { name: "确认并继续录制" });
    await user.click(resume);
    expect(controlCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resume",
        sessionId: recording.sessionId,
      }),
    );
  });

  describe("explicit recovery decisions", () => {
    it("partitions mixed candidates into a restorable dialog and silent preserved data", async () => {
      const restorable = recoveryItem({
        sessionId: "session-recovery-restorable-123456",
      });
      const discardOnly = recoveryItem({
        sessionId: "session-recovery-discard-only-123456",
        capability: "discard-only",
        reason: "no-audio-data",
      });
      const preserveOnly = recoveryItem({
        sessionId: "session-recovery-preserve-only-123456",
        capability: "preserve-only",
        reason: "currently-unverifiable",
      });
      const actOnCaptureRecovery = vi.fn(async () =>
        recoveryResponse({
          outcomes: [
            {
              sessionId: discardOnly.sessionId,
              action: "discard",
              result: "discarded",
              completionCertainty: "completed",
              audioDurability: "discarded",
              transcriptionHandoff: "not-requested",
              capture: null,
            },
          ],
          recoveries: [restorable, preserveOnly],
        }),
      );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [
          restorable,
          discardOnly,
          preserveOnly,
        ]),
        actOnCaptureRecovery,
      });

      render(<CaptureWorkspace capture={idle} detailOpen={false} />);

      const dialog = await screen.findByRole("dialog", {
        name: "发现可恢复的录音",
      });
      expect(dialog).toHaveTextContent("发现 1 段可恢复录音");
      expect(screen.getByRole("button", { name: "删除数据" })).toBeVisible();
      expect(screen.getByRole("button", { name: "立即恢复" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
      expect(screen.queryByText("忽略")).toBeNull();
      await waitFor(() =>
        expect(actOnCaptureRecovery).toHaveBeenCalledTimes(1),
      );
      expect(actOnCaptureRecovery).toHaveBeenCalledWith({
        action: "discard",
        intent: "automatic-discard-only-cleanup",
        sessionIds: [discardOnly.sessionId],
        idempotencyKey: expect.any(String),
      });
      expect(toastSpies.success).toHaveBeenCalledWith(
        "1 段无可恢复内容的录音数据已处理。",
        expect.objectContaining({ id: "capture-recovery-cleanup-completed" }),
      );
      expect(toastSpies.warning).not.toHaveBeenCalled();
    });

    it("requires an explicit delete and freezes the user-decision request while pending", async () => {
      const first = recoveryItem({
        sessionId: "session-recovery-delete-first-123456",
      });
      const second = recoveryItem({
        sessionId: "session-recovery-delete-second-123456",
      });
      let resolveRecovery!: (value: CaptureRecoveryActionResponse) => void;
      const actOnCaptureRecovery = vi.fn(
        () =>
          new Promise<CaptureRecoveryActionResponse>((resolve) => {
            resolveRecovery = resolve;
          }),
      );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [first, second]),
        actOnCaptureRecovery,
      });
      const user = userEvent.setup();
      render(<CaptureWorkspace capture={idle} />);

      const dialog = await screen.findByRole("dialog");
      fireEvent.keyDown(dialog, { key: "Escape" });
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      fireEvent.pointerDown(overlay!);
      fireEvent.click(overlay!);
      expect(actOnCaptureRecovery).not.toHaveBeenCalled();
      expect(dialog).toBeVisible();

      await user.click(screen.getByRole("button", { name: "删除数据" }));
      expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "立即恢复" })).toBeDisabled();
      expect(actOnCaptureRecovery).toHaveBeenCalledTimes(1);
      expect(actOnCaptureRecovery).toHaveBeenCalledWith({
        action: "discard",
        intent: "user-decision",
        sessionIds: [first.sessionId, second.sessionId],
        idempotencyKey: expect.any(String),
      });

      await act(async () =>
        resolveRecovery(
          recoveryResponse({
            outcomes: [first, second].map((item) => ({
              sessionId: item.sessionId,
              action: "discard" as const,
              result: "discarded" as const,
              completionCertainty: "completed" as const,
              audioDurability: "discarded" as const,
              transcriptionHandoff: "not-requested" as const,
              capture: null,
            })),
          }),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("replays a lost restore response once and then exposes only the same action for retry", async () => {
      const item = recoveryItem();
      const actOnCaptureRecovery = vi
        .fn<Voice2TextDesktopApi["actOnCaptureRecovery"]>()
        .mockRejectedValueOnce(new Error("lost"))
        .mockRejectedValueOnce(new Error("still lost"))
        .mockResolvedValueOnce(
          recoveryResponse({
            outcomes: [
              {
                sessionId: item.sessionId,
                action: "keep",
                result: "kept",
                completionCertainty: "completed",
                audioDurability: "durable",
                transcriptionHandoff: "completed",
                capture: item,
              },
            ],
          }),
        );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [item]),
        actOnCaptureRecovery,
      });
      const user = userEvent.setup();
      render(<CaptureWorkspace capture={idle} />);

      await user.click(await screen.findByRole("button", { name: "立即恢复" }));
      expect(
        await screen.findByText("数据状态尚未确认，请再次执行原操作。"),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "删除数据" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "立即恢复" })).toBeEnabled();
      expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2);
      expect(actOnCaptureRecovery.mock.calls[1]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );

      await user.click(screen.getByRole("button", { name: "立即恢复" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(actOnCaptureRecovery).toHaveBeenCalledTimes(3);
      expect(actOnCaptureRecovery.mock.calls[2]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );
    });

    it("replays an unconfirmed automatic cleanup once with the same request and warns without success", async () => {
      const item = recoveryItem({
        capability: "discard-only",
        reason: "no-audio-data",
      });
      const unknown = recoveryResponse({
        outcomes: [
          {
            sessionId: item.sessionId,
            action: "discard",
            result: "failed",
            completionCertainty: "unknown",
            audioDurability: "unknown",
            transcriptionHandoff: "not-requested",
            capture: item,
          },
        ],
        recoveries: [item],
      });
      const actOnCaptureRecovery = vi.fn(
        async (request: CaptureRecoveryActionRequest) => {
          void request;
          return unknown;
        },
      );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [item]),
        actOnCaptureRecovery,
      });

      render(<CaptureWorkspace capture={idle} />);

      await waitFor(() =>
        expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2),
      );
      expect(actOnCaptureRecovery.mock.calls[1]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(toastSpies.success).not.toHaveBeenCalled();
      expect(toastSpies.warning).toHaveBeenCalledWith(
        "数据尚未确认删除，下次启动将重新检查。",
        expect.objectContaining({ id: "capture-recovery-cleanup-unconfirmed" }),
      );
    });

    it("replays a rejected automatic cleanup once with the same request and warns without success", async () => {
      const item = recoveryItem({
        capability: "discard-only",
        reason: "no-audio-data",
      });
      const actOnCaptureRecovery = vi
        .fn<Voice2TextDesktopApi["actOnCaptureRecovery"]>()
        .mockRejectedValueOnce(new Error("cleanup response lost"))
        .mockRejectedValueOnce(new Error("cleanup response still lost"));
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [item]),
        actOnCaptureRecovery,
      });

      render(<CaptureWorkspace capture={idle} />);

      await waitFor(() =>
        expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2),
      );
      expect(actOnCaptureRecovery.mock.calls[1]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );
      expect(actOnCaptureRecovery.mock.calls[0]?.[0]).toMatchObject({
        action: "discard",
        intent: "automatic-discard-only-cleanup",
        sessionIds: [item.sessionId],
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(toastSpies.success).not.toHaveBeenCalled();
      expect(toastSpies.warning).toHaveBeenCalledWith(
        "数据尚未确认删除，下次启动将重新检查。",
        expect.objectContaining({ id: "capture-recovery-cleanup-unconfirmed" }),
      );
    });

    it("returns a confirmed conflict to the two-action choice using authoritative recoveries", async () => {
      const item = recoveryItem();
      const actOnCaptureRecovery = vi.fn(async () =>
        recoveryResponse({
          outcomes: [
            {
              sessionId: item.sessionId,
              action: "discard",
              result: "conflict",
              completionCertainty: "not-completed",
              audioDurability: "unchanged",
              transcriptionHandoff: "not-requested",
              capture: item,
            },
          ],
          recoveries: [item],
        }),
      );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [item]),
        actOnCaptureRecovery,
      });
      const user = userEvent.setup();
      render(<CaptureWorkspace capture={idle} />);

      await user.click(await screen.findByRole("button", { name: "删除数据" }));

      expect(
        await screen.findByRole("button", { name: "删除数据" }),
      ).toBeEnabled();
      expect(screen.getByRole("button", { name: "立即恢复" })).toBeEnabled();
      expect(actOnCaptureRecovery).toHaveBeenCalledTimes(1);
    });

    it("silently preserves passive preserve-only candidates without opening a dialog or mutating data", async () => {
      const item = recoveryItem({
        capability: "preserve-only",
        reason: "audio-integrity-failed",
      });
      const api = installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [item]),
      });
      const view = render(<CaptureWorkspace capture={idle} />);

      await waitFor(() =>
        expect(api.listCaptureRecoveries).toHaveBeenCalledOnce(),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(toastSpies.warning).not.toHaveBeenCalled();
      expect(api.actOnCaptureRecovery).not.toHaveBeenCalled();
      view.rerender(
        <CaptureWorkspace capture={idle} focusSessionId={item.sessionId} />,
      );
      await waitFor(() =>
        expect(api.listCaptureRecoveries).toHaveBeenCalledTimes(2),
      );
      expect(toastSpies.warning).not.toHaveBeenCalled();
      expect(api.actOnCaptureRecovery).not.toHaveBeenCalled();
    });

    it("routes an automatically reclassified cleanup target into the decision dialog", async () => {
      const discardOnly = recoveryItem({
        capability: "discard-only",
        reason: "no-audio-data",
      });
      const restorable = recoveryItem({
        sessionId: discardOnly.sessionId,
      });
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [discardOnly]),
        actOnCaptureRecovery: vi.fn(async () =>
          recoveryResponse({
            outcomes: [
              {
                sessionId: discardOnly.sessionId,
                action: "discard",
                result: "preserved",
                completionCertainty: "not-completed",
                audioDurability: "preserved",
                transcriptionHandoff: "not-requested",
                capture: discardOnly,
              },
            ],
            recoveries: [restorable],
          }),
        ),
      });

      render(<CaptureWorkspace capture={idle} />);

      expect(
        await screen.findByRole("dialog", { name: "发现可恢复的录音" }),
      ).toHaveTextContent("发现 1 段可恢复录音");
      expect(toastSpies.success).not.toHaveBeenCalled();
      expect(toastSpies.warning).not.toHaveBeenCalledWith(
        "数据尚未确认删除，下次启动将重新检查。",
        expect.anything(),
      );
    });

    it("keeps the exact original request after a partial result while showing only the unresolved item", async () => {
      const completed = recoveryItem({
        sessionId: "session-recovery-partial-complete-123456",
      });
      const unresolved = recoveryItem({
        sessionId: "session-recovery-partial-unknown-123456",
      });
      const unresolvedResponse = recoveryResponse({
        outcomes: [
          {
            sessionId: completed.sessionId,
            action: "keep",
            result: "kept",
            completionCertainty: "completed",
            audioDurability: "durable",
            transcriptionHandoff: "completed",
            capture: completed,
          },
          {
            sessionId: unresolved.sessionId,
            action: "keep",
            result: "failed",
            completionCertainty: "unknown",
            audioDurability: "unknown",
            transcriptionHandoff: "not-requested",
            capture: unresolved,
          },
        ],
        recoveries: [unresolved],
      });
      const actOnCaptureRecovery = vi
        .fn<Voice2TextDesktopApi["actOnCaptureRecovery"]>()
        .mockResolvedValueOnce(unresolvedResponse)
        .mockResolvedValueOnce(unresolvedResponse)
        .mockResolvedValueOnce(
          recoveryResponse({
            outcomes: [
              {
                sessionId: completed.sessionId,
                action: "keep",
                result: "kept",
                completionCertainty: "completed",
                audioDurability: "durable",
                transcriptionHandoff: "completed",
                capture: completed,
              },
              {
                sessionId: unresolved.sessionId,
                action: "keep",
                result: "kept",
                completionCertainty: "completed",
                audioDurability: "durable",
                transcriptionHandoff: "completed",
                capture: unresolved,
              },
            ],
          }),
        );
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [completed, unresolved]),
        actOnCaptureRecovery,
      });
      const user = userEvent.setup();
      render(<CaptureWorkspace capture={idle} />);

      await user.click(await screen.findByRole("button", { name: "立即恢复" }));

      expect(await screen.findByText(/发现 1 段可恢复录音/)).toBeVisible();
      expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2);
      expect(actOnCaptureRecovery.mock.calls[1]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );
      expect(actOnCaptureRecovery.mock.calls[0]?.[0].sessionIds).toEqual([
        completed.sessionId,
        unresolved.sessionId,
      ]);

      await user.click(screen.getByRole("button", { name: "立即恢复" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(actOnCaptureRecovery.mock.calls[2]?.[0]).toEqual(
        actOnCaptureRecovery.mock.calls[0]?.[0],
      );
    });
  });

  it("shows an action failure in a modal and unlocks the control", async () => {
    installCaptureApi({
      controlCapture: vi
        .fn()
        .mockRejectedValueOnce(new Error("raw /private/capture service"))
        .mockResolvedValueOnce(recording),
    });
    const user = userEvent.setup();
    render(
      <CaptureWorkspace
        applicationRevision={1}
        capture={{
          phase: "paused",
          sessionId: recording.sessionId,
          title: "访谈录制",
          elapsedMs: 5_000,
        }}
      />,
    );

    const resume = screen.getByRole("button", { name: "继续录制" });
    resume.focus();
    await user.click(resume);
    const errorDialog = await screen.findByRole("dialog", {
      name: "录制遇到问题",
    });
    expect(errorDialog).toHaveTextContent("录制操作未完成");
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(resume).toBeEnabled());
    await user.click(
      within(errorDialog).getByRole("button", { name: "知道了" }),
    );
    await user.click(screen.getByRole("button", { name: "继续录制" }));
  });

  it("keeps the generated title out of the header until recording starts", async () => {
    installCaptureApi();
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() =>
      expect(window.voice2text.startCapture).toHaveBeenCalled(),
    );
    expect(
      screen.queryByRole("button", { name: "新录音2026090501" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "新录音2026090501" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "录制名称" })).toBeNull();
  });

  it("treats a kept partial recovery as finalized when no track is live", async () => {
    const recoverable: CaptureRecoveryItem = {
      ...recording,
      title: "Recover-音频录制",
      state: "recoverable",
      systemAudioHealthy: false,
      microphoneHealthy: false,
      partialCapture: true,
      finalizedChunkCount: 2,
      journalSha256: "b".repeat(64),
      capability: "restorable",
      reason: null,
    };
    const kept: CaptureSnapshot = {
      ...recoverable,
      state: "partial_capture",
      recordingSha256: "b".repeat(64),
    };
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
      actOnCaptureRecovery: vi.fn(async () =>
        recoveryResponse({
          outcomes: [
            {
              sessionId: recoverable.sessionId,
              action: "keep",
              result: "kept",
              completionCertainty: "completed",
              audioDurability: "durable",
              transcriptionHandoff: "completed",
              capture: kept,
            },
          ],
        }),
      ),
    });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={7} />,
    );

    await user.click(await screen.findByRole("button", { name: "立即恢复" }));
    view.rerender(
      <CaptureWorkspace
        capture={{
          phase: "partial_capture",
          sessionId: kept.sessionId,
          title: "恢复的音频录制",
          elapsedMs: kept.captureTimelineMs,
          partialCapture: true,
          systemAudioHealthy: false,
          microphoneHealthy: false,
        }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "暂停录制" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止并保存" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "录制另一个音频" }),
    ).toBeEnabled();
  });

  it("reloads recovery actions when Main capture bootstrap finishes after mount", async () => {
    const recoverable: CaptureRecoveryItem = {
      ...recording,
      title: "Recover-音频录制",
      state: "recoverable",
      systemAudioHealthy: false,
      microphoneHealthy: false,
      finalizedChunkCount: 1,
      journalSha256: "c".repeat(64),
      capability: "restorable",
      reason: null,
    };
    const listCaptureRecoveries = vi
      .fn<Voice2TextDesktopApi["listCaptureRecoveries"]>()
      .mockRejectedValueOnce(new Error("raw /private/capture bootstrap"))
      .mockResolvedValueOnce([recoverable]);
    installCaptureApi({ listCaptureRecoveries });
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={1} />,
    );
    expect(
      await screen.findByRole("dialog", { name: "录制遇到问题" }),
    ).toHaveTextContent("无法检查可恢复录制");

    view.rerender(
      <CaptureWorkspace
        applicationRevision={2}
        capture={{
          phase: "recovery",
          sessionId: recoverable.sessionId,
          title: "中断的音频录制",
          elapsedMs: recoverable.captureTimelineMs,
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "发现可恢复的录音" }),
    ).toBeVisible();
    expect(screen.queryByText(/private\/capture/)).not.toBeInTheDocument();
    expect(listCaptureRecoveries).toHaveBeenCalledTimes(2);
  });

  it("opens a recovery dialog without replacing the current workspace", async () => {
    const recoverable: CaptureRecoveryItem = {
      ...recording,
      title: "Recover-音频录制",
      state: "recoverable",
      systemAudioHealthy: false,
      microphoneHealthy: false,
      capability: "restorable",
      reason: null,
    };
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
    });
    const onDetailOpenChange = vi.fn();

    render(
      <CaptureWorkspace
        capture={idle}
        detailOpen={false}
        onDetailOpenChange={onDetailOpenChange}
      />,
    );

    expect(
      await screen.findByRole("dialog", { name: "发现可恢复的录音" }),
    ).toBeVisible();
    expect(onDetailOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "录制详情" }),
    ).not.toBeInTheDocument();
  });
});
