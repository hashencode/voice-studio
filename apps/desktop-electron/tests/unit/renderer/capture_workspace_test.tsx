// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureWorkspace,
  FloatingCapturePreferenceSetting,
} from "../../../src/renderer/features/capture/capture-workspace";
import type {
  ApplicationSnapshot,
  CapturePreflight,
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

afterEach(() => vi.restoreAllMocks());

function installCaptureApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  const api = {
    preflightCapture: vi.fn(async () => readyPreflight),
    startCapture: vi.fn(async () => recording),
    controlCapture: vi.fn(async () => recording),
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

describe("capture workspace", () => {
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

  it("starts once on repeated activation and exposes a semantic recording status", async () => {
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
    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();
    expect(
      screen.getByRole("status", { name: "录制操作状态" }),
    ).toHaveTextContent("正在开始录制");

    resolveStart(recording);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "录制操作状态" }),
      ).toHaveTextContent("录制已经开始"),
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
    expect(
      await screen.findByRole("status", { name: "录制状态" }),
    ).toHaveTextContent("正在录制");
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

  it("guards repeated stop and announces the completed terminal state", async () => {
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
    const confirm = screen.getByRole("button", { name: "确认停止并保存" });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(controlCapture).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(
      screen.getByRole("status", { name: "录制操作状态" }),
    ).toHaveTextContent("正在安全结束录制");

    resolveStop(completed);
    await waitFor(() => expect(confirm).toBeEnabled());
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
    expect(
      await screen.findByRole("status", { name: "录制状态" }),
    ).toHaveTextContent("录制已完成");

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

  it("pauses from the keyboard and renders the returned state", async () => {
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
    pause.focus();
    await user.keyboard("{Enter}");
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
    expect(
      await screen.findByRole("status", { name: "录制状态" }),
    ).toHaveTextContent("录制已暂停");
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
    expect(screen.getByRole("status", { name: "录制状态" })).toHaveTextContent(
      "电脑睡眠，录制已暂停",
    );

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
    resume.focus();
    await user.keyboard("{Enter}");
    expect(controlCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resume",
        sessionId: recording.sessionId,
      }),
    );
  });

  it("restores recoveries and offers explicit keep or discard actions", async () => {
    const recoverable: CaptureSnapshot = {
      ...recording,
      state: "recoverable",
      captureTimelineMs: 15_000,
      interruptionReason: "renderer_reloaded",
      finalizedChunkCount: 3,
      gapCount: 1,
    };
    const actOnCaptureRecovery = vi.fn(async () => null);
    installCaptureApi({
      listCaptureRecoveries: vi.fn(async () => [recoverable]),
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
      screen.getByText("应用关闭或重新载入不会删除已保存的录音。"),
    ).toBeVisible();
    expect(screen.getByText(/00:15 · 1 个时间缺口/)).toBeVisible();
    expect(screen.queryByText(/Renderer|分块/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /丢弃/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "管理恢复录制" }));
    await user.click(screen.getByRole("button", { name: "丢弃这段恢复录制" }));
    expect(actOnCaptureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discard",
        sessionId: recoverable.sessionId,
      }),
    );

    view.unmount();
    vi.mocked(actOnCaptureRecovery).mockClear();
    vi.mocked(window.voice2text.listCaptureRecoveries).mockResolvedValueOnce([
      recoverable,
    ]);
    render(<CaptureWorkspace capture={idle} applicationRevision={6} />);
    await user.click(
      await screen.findByRole("button", { name: "保留并完成恢复" }),
    );
    expect(actOnCaptureRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "keep",
        sessionId: recoverable.sessionId,
      }),
    );
  });

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

    await user.click(screen.getByRole("button", { name: "继续录制" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "录制操作未完成",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续录制" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "继续录制" }));
  });

  it("treats a kept partial recovery as finalized when no track is live", async () => {
    const recoverable: CaptureSnapshot = {
      ...recording,
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

    await user.click(
      await screen.findByRole("button", { name: "保留并完成恢复" }),
    );
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
    const recoverable: CaptureSnapshot = {
      ...recording,
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

  it("opens recording details when recoverable audio is discovered", async () => {
    const recoverable: CaptureSnapshot = {
      ...recording,
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

    await waitFor(() => expect(onDetailOpenChange).toHaveBeenCalledWith(true));
  });
});
