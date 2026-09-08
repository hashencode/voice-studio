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

afterEach(() => {
  window.localStorage.clear();
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
    actOnCaptureRecovery: vi.fn(async () => null),
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
    ["finalizing", "正在停止并保存", "暂停录制", true, "停止并保存", true],
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

  it("uses a fixed waveform animation only while audio input is detected", () => {
    installCaptureApi();
    const capture = (sessionId: string, audioActivity: number) =>
      ({
        phase: "recording",
        sessionId,
        title: "访谈录制",
        elapsedMs: 5_000,
        audioActivity,
      }) satisfies ApplicationSnapshot["capture"];
    const view = renderCaptureProjection(capture("session-one", 0));

    const bars = () =>
      within(screen.getByLabelText("录音活动")).getAllByTestId(
        "capture-activity-sample",
      );
    expect(bars()).toHaveLength(16);
    expect(screen.getByLabelText("录音活动")).toHaveAttribute(
      "data-input-active",
      "false",
    );
    const fixedPattern = bars().map((bar) => bar.getAttribute("style"));

    view.rerender(
      <CaptureWorkspaceController capture={capture("session-one", 0.1)}>
        {({ footer }) => <aside data-testid="footer-slot">{footer}</aside>}
      </CaptureWorkspaceController>,
    );
    expect(screen.getByLabelText("录音活动")).toHaveAttribute(
      "data-input-active",
      "true",
    );
    expect(bars().map((bar) => bar.getAttribute("style"))).toEqual(
      fixedPattern,
    );

    view.rerender(
      <CaptureWorkspaceController
        capture={{ ...capture("session-one", 1), phase: "paused" }}
      >
        {({ footer }) => <aside data-testid="footer-slot">{footer}</aside>}
      </CaptureWorkspaceController>,
    );
    expect(screen.getByLabelText("录音活动")).toHaveAttribute(
      "data-input-active",
      "false",
    );
  });

  it("does not project a footer before a session exists", () => {
    installCaptureApi();
    renderCaptureProjection(idle);
    expect(screen.getByTestId("footer-slot")).toBeEmptyDOMElement();
  });

  it("projects the suggested setup title into the page header and starts with it", async () => {
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    expect(screen.queryByRole("button", { name: "编辑录制名称" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始录制" })).toBeNull();

    resolveSuggestion({ title: "新录音2026090507" });
    expect(
      await screen.findByRole("button", { name: "新录音2026090507" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "新录音2026090507",
          refreshSuggestedTitle: true,
        }),
      ),
    );
  });

  it("keeps a setup title edited on blur when starting the capture", async () => {
    const startCapture = vi.fn(async () => recording);
    installCaptureApi({ startCapture });
    const user = userEvent.setup();
    renderCaptureProjection(idle);

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await user.click(
      await screen.findByRole("button", { name: "新录音2026090501" }),
    );
    const input = screen.getByRole("textbox", { name: "录制名称" });
    await user.clear(input);
    await user.type(input, "客户访谈");
    fireEvent.blur(input);
    await user.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() =>
      expect(startCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "客户访谈",
          refreshSuggestedTitle: false,
        }),
      ),
    );
  });

  it("edits an active title through one native input and persists its trimmed blur value", async () => {
    const renameCaptureSession = vi.fn(async () => ({
      capture: { ...idle },
    })) as unknown as Voice2TextDesktopApi["renameCaptureSession"];
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

    await user.click(await screen.findByRole("button", { name: "客户访谈" }));
    const input = screen.getByRole("textbox", { name: "录制名称" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", "50");
    expect(input).toHaveClass("min-w-[180px]");
    await user.clear(input);
    await user.type(input, "  产品回访  ");
    fireEvent.blur(input);
    await waitFor(() =>
      expect(renameCaptureSession).toHaveBeenCalledWith({
        sessionId: recording.sessionId,
        title: "产品回访",
      }),
    );
    expect(screen.queryByText("跨页面持续运行，由本机安全保存。")).toBeNull();
    expect(screen.queryByLabelText("录制名称")).toBeNull();
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

    expect(await screen.findByText("季度访谈")).toBeVisible();
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
    expect(
      screen.queryByRole("alertdialog", { name: "确认停止并保存" }),
    ).toBeNull();
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
      await screen.findByRole("alertdialog", { name: "确认停止并保存" }),
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
      await screen.findByRole("alertdialog", { name: "确认停止并保存" }),
    ).toBeVisible();
  });

  it("shows the focused recovery only in the recovery dialog", async () => {
    const focusedRecovery: CaptureRecoveryItem = {
      ...recording,
      sessionId: "session-recovery-focused-123456",
      title: `Recover-${"访".repeat(50)}`,
      state: "recoverable",
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
      name: "发现可恢复录制",
    });
    expect(
      within(dialog).getByText("发现 1 段未完成的录音，可一次恢复并保存。"),
    ).toBeVisible();
    expect(within(dialog).queryByText(focusedRecovery.title)).toBeNull();
    expect(screen.queryByText("其他活动录制")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "录制名称" })).toBeNull();
    expect(screen.queryByTestId("footer-slot")).toBeNull();
    expect(screen.queryByRole("region", { name: "录制详情" })).toBeNull();
  });

  it("exits setup and opens a Dialog when title suggestion fails", async () => {
    const onDetailOpenChange = vi.fn();
    installCaptureApi({
      suggestCaptureTitle: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const user = userEvent.setup();
    render(
      <CaptureWorkspaceController
        capture={idle}
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    expect(
      await screen.findByRole("dialog", { name: "无法准备录制名称" }),
    ).toBeVisible();
    expect(onDetailOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("button", { name: "开始录制" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑录制名称" })).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await user.click(screen.getByRole("button", { name: "开始录制" }));

    expect(startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ microphoneDeviceId: "mic-usb" }),
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await user.click(screen.getByRole("button", { name: "开始录制" }));

    expect(startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ microphoneDeviceId: "mic-default" }),
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
  ])("does not surface redundant preflight controls for %s", async (reason) => {
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await waitFor(() => expect(onPreflightResolved).toHaveBeenCalledOnce());
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
  });

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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await waitFor(() => expect(onPreflightResolved).toHaveBeenCalledOnce());
    await screen.findByRole("heading", { name: "设置音频录制" });
    expect(screen.queryByText("本机字幕模型不可用")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始录制" })).toBeEnabled();
    expect(
      screen.queryByRole("switch", { name: /同时生成本机字幕/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始录制" }));
    expect(startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ captionEnabled: false }),
    );
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    await waitFor(() => expect(api.preflightCapture).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "设置音频录制" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("麦克风权限被拒绝")).not.toBeInTheDocument();
    expect(screen.queryByText("可使用降级录制")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始录制" }),
    ).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={1} />,
    );

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    const workspace = screen.getByRole("region", { name: "录制详情" });
    expect(workspace).not.toHaveAttribute("data-slot", "card");
    expect(workspace).not.toHaveClass("fixed", "shadow-lg");
    const start = await screen.findByRole("button", { name: "开始录制" });
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(startCapture).toHaveBeenCalledTimes(1));
    expect(start).toBeDisabled();
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

  it("starts setup from the primary record action after completion", async () => {
    installCaptureApi();
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

    expect(
      await screen.findByRole("heading", { name: "设置音频录制" }),
    ).toBeVisible();
    expect(window.voice2text.preflightCapture).toHaveBeenCalledTimes(1);
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

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    expect(
      screen.queryByRole("combobox", { name: "麦克风" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始录制" }));

    expect(startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ microphoneDeviceId: "mic-default" }),
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
    const dialog = screen.getByRole("alertdialog", { name: "确认停止并保存" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(controlCapture).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(stop);
    const confirm = screen.getByRole("button", { name: "确认停止并保存" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(controlCapture).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByText("正在停止并保存")).toBeVisible();

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
    expect(
      await screen.findByRole("heading", { name: "设置音频录制" }),
    ).toBeVisible();
    expect(window.voice2text.preflightCapture).toHaveBeenCalledWith({
      requestPermissions: true,
      captionEnabled: true,
    });
  });

  it("allows a failed stop confirmation to be retried", async () => {
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
    const confirm = screen.getByRole("button", { name: "确认停止并保存" });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeEnabled());
    expect(
      screen.getByText(
        "停止录制未完成，请重试；如需退出，可保留录音数据并在下次启动时恢复。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/native helper|private\/capture/)).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(confirm);
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
      fireEvent.click(screen.getByRole("button", { name: "确认停止并保存" }));
      expect(
        await screen.findByText("停止录制未完成", { exact: false }),
      ).toBeInTheDocument();

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

      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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

  it("restores or discards all recoveries without rendering a list", async () => {
    const recoverable: CaptureRecoveryItem = {
      ...recording,
      title: "Recover-音频录制",
      state: "recoverable",
      captureTimelineMs: 15_000,
      interruptionReason: "renderer_reloaded",
      finalizedChunkCount: 3,
      gapCount: 1,
    };
    const anotherRecovery: CaptureRecoveryItem = {
      ...recoverable,
      sessionId: "session-recovery-second-123456",
      title: "Recover-另一段音频录制",
      captureTimelineMs: 4_000,
    };
    const actOnCaptureRecovery = vi.fn(async () => null);
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable, anotherRecovery]),
      actOnCaptureRecovery,
    });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={5} />,
    );

    expect(
      await screen.findByRole("heading", { name: "发现可恢复录制" }),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "发现可恢复录制" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "录制详情" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("发现 2 段未完成的录音，可一次恢复并保存。"),
    ).toBeVisible();
    const restoreButton = screen.getByRole("button", { name: "恢复数据" });
    expect(restoreButton).toHaveFocus();
    expect(restoreButton.querySelector("svg.lucide-rotate-ccw")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "丢弃" })).toBeNull();
    expect(screen.queryByText(recoverable.title)).toBeNull();
    expect(screen.queryByText(anotherRecovery.title)).toBeNull();
    expect(screen.queryByText(/00:15|00:04|时间缺口/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2));
    expect(actOnCaptureRecovery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "discard",
        sessionId: recoverable.sessionId,
      }),
    );
    expect(actOnCaptureRecovery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "discard",
        sessionId: anotherRecovery.sessionId,
      }),
    );

    view.unmount();
    vi.mocked(actOnCaptureRecovery).mockClear();
    vi.mocked(window.voice2text.listCaptureRecoveries).mockResolvedValueOnce([
      recoverable,
      anotherRecovery,
    ]);
    render(<CaptureWorkspace capture={idle} applicationRevision={6} />);
    await user.click(await screen.findByRole("button", { name: "恢复数据" }));
    await waitFor(() => expect(actOnCaptureRecovery).toHaveBeenCalledTimes(2));
    expect(actOnCaptureRecovery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "keep",
        sessionId: recoverable.sessionId,
      }),
    );
    expect(actOnCaptureRecovery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "keep",
        sessionId: anotherRecovery.sessionId,
      }),
    );
  });

  it("hides the recovery close control while restore is pending", async () => {
    const recoverable: CaptureRecoveryItem = {
      ...recording,
      title: "Recover-等待恢复的录音",
      state: "recoverable",
    };
    let resolveRecovery!: (value: CaptureSnapshot | null) => void;
    const pendingRecovery = new Promise<CaptureSnapshot | null>((resolve) => {
      resolveRecovery = resolve;
    });
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
      actOnCaptureRecovery: vi.fn(() => pendingRecovery),
    });
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} />);

    await user.click(await screen.findByRole("button", { name: "恢复数据" }));

    expect(screen.getByRole("button", { name: "正在恢复…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();

    await act(async () => resolveRecovery(null));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "发现可恢复录制" }),
      ).toBeNull(),
    );
  });

  it.each([
    { action: "keep" as const, buttonName: "恢复数据" },
    { action: "discard" as const, buttonName: "关闭" },
  ])(
    "retries only the recoveries left after a partial $action batch failure",
    async ({ action, buttonName }) => {
      const firstRecovery: CaptureRecoveryItem = {
        ...recording,
        sessionId: "session-recovery-first-123456",
        title: "Recover-第一段录音",
        state: "recoverable",
      };
      const secondRecovery: CaptureRecoveryItem = {
        ...firstRecovery,
        sessionId: "session-recovery-second-123456",
        title: "Recover-第二段录音",
      };
      const actOnCaptureRecovery = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("native recovery failed"))
        .mockResolvedValueOnce(null);
      installCaptureApi({
        listCaptureRecoveries: vi.fn(async () => [
          firstRecovery,
          secondRecovery,
        ]),
        actOnCaptureRecovery,
      });
      const user = userEvent.setup();
      render(<CaptureWorkspace capture={idle} />);

      await user.click(await screen.findByRole("button", { name: buttonName }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "录制操作未完成",
      );
      expect(
        screen.getByText("发现 1 段未完成的录音，可一次恢复并保存。"),
      ).toBeVisible();

      await user.click(screen.getByRole("button", { name: buttonName }));
      await waitFor(() =>
        expect(actOnCaptureRecovery).toHaveBeenCalledTimes(3),
      );
      expect(actOnCaptureRecovery).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          action,
          sessionId: secondRecovery.sessionId,
        }),
      );
    },
  );

  it("recovers from an action failure and unlocks the control", async () => {
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
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "录制操作未完成",
    );
    expect(resume).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续录制" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "继续录制" }));
  });

  it("keeps the setup title in the header until the user edits it", async () => {
    installCaptureApi();
    const user = userEvent.setup();
    render(<CaptureWorkspace capture={idle} applicationRevision={1} />);

    await user.click(screen.getByRole("button", { name: "检查并设置录制" }));
    const title = await screen.findByRole("button", {
      name: "新录音2026090501",
    });
    expect(title).not.toHaveFocus();
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
    };
    const kept: CaptureSnapshot = {
      ...recoverable,
      state: "partial_capture",
      recordingSha256: "b".repeat(64),
    };
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
      actOnCaptureRecovery: vi.fn(async () => kept),
    });
    const user = userEvent.setup();
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={7} />,
    );

    await user.click(await screen.findByRole("button", { name: "恢复数据" }));
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
    };
    const listCaptureRecoveries = vi
      .fn<Voice2TextDesktopApi["listCaptureRecoveries"]>()
      .mockRejectedValueOnce(new Error("raw /private/capture bootstrap"))
      .mockResolvedValueOnce([recoverable]);
    installCaptureApi({ listCaptureRecoveries });
    const view = render(
      <CaptureWorkspace capture={idle} applicationRevision={1} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法检查可恢复录制",
    );

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
      await screen.findByRole("heading", { name: "发现可恢复录制" }),
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
    };
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
    });
    const onDetailOpenChange = vi.fn();

    render(
      <CaptureWorkspace
        capture={idle}
        detailOpen={false}
        autoOpenRecoveries
        onDetailOpenChange={onDetailOpenChange}
      />,
    );

    expect(
      await screen.findByRole("dialog", { name: "发现可恢复录制" }),
    ).toBeVisible();
    expect(onDetailOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "录制详情" }),
    ).not.toBeInTheDocument();
  });
});
