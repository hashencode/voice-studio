// @vitest-environment jsdom

import * as React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import {
  MicrophoneTestDialog,
  useMicrophoneTestController,
} from "../../../src/renderer/features/capture/microphone-test-dialog";
import {
  RECORDING_PREFERENCE_STORAGE_KEY,
  useRecordingPreference,
} from "../../../src/renderer/features/capture/use-recording-preference";
import type { Voice2TextDesktopApi } from "../../../src/shared/contracts";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("uses the native capture lifecycle for a user-ended microphone test", async () => {
  const running = {
    testId: "mic-test-123456789012",
    state: "running" as const,
    elapsedMs: 1_000,
    normalizedRMS: 0.1,
    normalizedPeak: 0.5,
    observedFrames: 10,
    observedSound: true,
  };
  const startMicrophoneTest = vi.fn(async () => running);
  const finishMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "finished" as const,
    reason: "detected" as const,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({ startMicrophoneTest, finishMicrophoneTest })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  const testingDialog = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  expect(
    within(testingDialog).queryByRole("button", { name: "开始测试" }),
  ).not.toBeInTheDocument();
  expect(within(testingDialog).getByRole("meter")).toHaveAttribute(
    "aria-valuenow",
    "67",
  );
  expect(testingDialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");
  expect(within(testingDialog).queryByRole("status")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(within(testingDialog).getByRole("button", { name: "结束测试" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("麦克风测试完成")).not.toBeInTheDocument();
  expect(startMicrophoneTest).toHaveBeenCalledWith({
    microphoneDeviceId: "mic-default",
  });
  expect(finishMicrophoneTest).toHaveBeenCalledWith(running.testId);
});

it("uses the persisted microphone for tests and recording", async () => {
  window.localStorage.setItem(
    RECORDING_PREFERENCE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      microphoneDeviceId: "mic-usb",
      microphoneName: "USB 麦克风",
    }),
  );
  const microphones = [
    { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
    { id: "mic-usb", name: "USB 麦克风", isDefault: false },
  ];
  const startMicrophoneTest = vi.fn(async () => ({
    testId: "mic-test-persisted-device",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  }));
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi({
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "dual_track" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "granted" as const,
          microphones,
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: [],
        })),
        startMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={onRecord}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  expect(startMicrophoneTest).toHaveBeenCalledWith({
    microphoneDeviceId: "mic-usb",
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "关闭" }));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "开始录制" }));
  expect(onRecord).toHaveBeenCalledOnce();
});

it("smooths the RMS meter and throttles its maximum", async () => {
  const running = {
    testId: "mic-test-rms-envelope-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0.1,
    normalizedPeak: 0.9,
    observedFrames: 1_024,
    observedSound: true,
  };
  const snapshots = [
    { ...running, elapsedMs: 200, normalizedRMS: 0.2, normalizedPeak: 0 },
    { ...running, elapsedMs: 300, normalizedRMS: 0, normalizedPeak: 1 },
    { ...running, elapsedMs: 400, normalizedRMS: 0, normalizedPeak: 1 },
    { ...running, elapsedMs: 500, normalizedRMS: 0, normalizedPeak: 1 },
  ];
  const getMicrophoneTestSnapshot = vi
    .fn<Voice2TextDesktopApi["getMicrophoneTestSnapshot"]>()
    .mockImplementation(async () => snapshots.shift() ?? running);
  const startMicrophoneTest = vi.fn(async () => running);
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));

  renderFirstUseRoute(
    api({
      startMicrophoneTest,
      getMicrophoneTestSnapshot,
      cancelMicrophoneTest,
    }),
  );

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  vi.useFakeTimers();
  try {
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = screen.getByRole("dialog", { name: "测试麦克风" });
    const meter = within(dialog).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "67");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();
    expect(meter).toHaveAttribute("aria-valuenow", "77");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "51");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "26");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −14 dBFS");

    await act(async () => {
      within(dialog).getByRole("button", { name: "关闭" }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: "测试麦克风" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startMicrophoneTest).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("dialog", { name: "测试麦克风" }),
    ).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps slow snapshots serial and releases by elapsed time", async () => {
  const running = {
    testId: "mic-test-slow-snapshot-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0.1,
    normalizedPeak: 0.9,
    observedFrames: 1_024,
    observedSound: true,
  };
  const slowSnapshot = deferred<typeof running>();
  const getMicrophoneTestSnapshot = vi
    .fn<Voice2TextDesktopApi["getMicrophoneTestSnapshot"]>()
    .mockImplementationOnce(() => slowSnapshot.promise)
    .mockImplementation(async () => ({
      ...running,
      elapsedMs: 700,
      normalizedRMS: 0,
    }));

  renderFirstUseRoute(
    api({
      startMicrophoneTest: vi.fn(async () => running),
      getMicrophoneTestSnapshot,
    }),
  );

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  vi.useFakeTimers();
  try {
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const meter = within(screen.getByRole("dialog")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "67");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      slowSnapshot.resolve({
        ...running,
        elapsedMs: 600,
        normalizedRMS: 0,
      });
      await Promise.resolve();
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("shows one instruction before sound and starts only once on rapid activation", async () => {
  const running = {
    testId: "mic-test-rapid-start-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const startMicrophoneTest = vi.fn(async () => running);
  const pendingSnapshot = deferred<typeof running>();
  const desktop = firstUseApi({
    startMicrophoneTest,
    getMicrophoneTestSnapshot: vi.fn(() => pendingSnapshot.promise),
  });
  const preflightCapture = vi.mocked(desktop.preflightCapture);
  renderRoute(desktop);

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  await waitFor(() => expect(trigger).toBeEnabled());
  preflightCapture.mockClear();
  act(() => {
    trigger.click();
    trigger.click();
  });

  const dialog = await screen.findByRole("dialog", { name: "测试麦克风" });
  await waitFor(() => expect(startMicrophoneTest).toHaveBeenCalledOnce());
  expect(preflightCapture).toHaveBeenCalledOnce();
  expect(dialog).toHaveTextContent("请对着麦克风说话。");
  expect(dialog).not.toHaveTextContent("暂未收到声音");
  expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "开始测试" }),
  ).not.toBeInTheDocument();
});

it("cancels a late microphone start exactly once after the dialog closes", async () => {
  const pendingStart =
    deferred<
      Awaited<ReturnType<Voice2TextDesktopApi["startMicrophoneTest"]>>
    >();
  const cancelMicrophoneTest = vi.fn(async (testId: string) => ({
    testId,
    state: "cancelled" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(() => pendingStart.promise),
        cancelMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  const starting = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  expect(starting).toHaveTextContent("正在连接麦克风…");
  expect(
    within(starting).queryByRole("button", { name: "结束测试" }),
  ).not.toBeInTheDocument();
  await user.click(within(starting).getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeDisabled();
  pendingStart.resolve({
    testId: "mic-test-late-start-123456",
    state: "running",
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  });
  await waitFor(() =>
    expect(cancelMicrophoneTest).toHaveBeenCalledWith(
      "mic-test-late-start-123456",
    ),
  );
  expect(cancelMicrophoneTest).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("cancels once and ignores a late running snapshot after closing during recovery", async () => {
  const running = {
    testId: "mic-test-recovery-close-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const pendingRecovery = deferred<typeof running>();
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));
  const getMicrophoneTestSnapshot = vi.fn(() => pendingRecovery.promise);
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => running),
        getMicrophoneTestSnapshot,
        cancelMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  const testing = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  await waitFor(() => expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce());
  await user.click(within(testing).getByRole("button", { name: "关闭" }));
  pendingRecovery.resolve({
    ...running,
    elapsedMs: 500,
    normalizedPeak: 0.7,
    observedFrames: 4_096,
    observedSound: true,
  });

  await waitFor(() => expect(cancelMicrophoneTest).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("已收到声音")).not.toBeInTheDocument();
});

it("cancels an active microphone test exactly once when its owner unmounts", async () => {
  const running = {
    testId: "mic-test-unmount-123456789",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));
  const view = renderFirstUseRoute(
    api({
      startMicrophoneTest: vi.fn(async () => running),
      cancelMicrophoneTest,
    }),
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  await screen.findByRole("dialog", { name: "测试麦克风" });
  view.unmount();

  await waitFor(() => expect(cancelMicrophoneTest).toHaveBeenCalledOnce());
});

it("shows helper contract failures with one close action and no settings affordance", async () => {
  const openMicrophoneSettings = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => ({
          testId: "mic-test-helper-mismatch-123456",
          state: "failed" as const,
          reason: "native-helper-failed" as const,
          elapsedMs: 0,
          normalizedRMS: 0,
          normalizedPeak: 0,
          observedFrames: 0,
          observedSound: false,
        })),
        openMicrophoneSettings,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));

  const failure = await screen.findByRole("dialog", {
    name: "麦克风测试失败",
  });
  expect(failure).toHaveTextContent("麦克风测试暂不可用，请重启应用。");
  expect(
    within(failure)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["知道了"]);
  expect(within(failure).getByRole("button", { name: "知道了" })).toBeVisible();
  expect(
    within(failure).queryByRole("button", { name: "前往麦克风设置" }),
  ).not.toBeInTheDocument();
  expect(openMicrophoneSettings).not.toHaveBeenCalled();
});

it("shows typed silence failure and the fixed settings fallback path", async () => {
  const running = {
    testId: "mic-test-silent-12345678",
    state: "running" as const,
    elapsedMs: 31_000,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 100,
    observedSound: false,
  };
  const openMicrophoneSettings = vi.fn(async () => ({
    state: "failed" as const,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => running),
        finishMicrophoneTest: vi.fn(async () => ({
          ...running,
          state: "finished" as const,
          reason: "no-sound-observed" as const,
        })),
        openMicrophoneSettings,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "测试麦克风" })).getByRole(
      "button",
      { name: "结束测试" },
    ),
  );
  const failure = await screen.findByRole("dialog", {
    name: "未检测到麦克风输入",
  });
  expect(failure).not.toHaveTextContent("31");
  await user.click(
    within(failure).getByRole("button", { name: "前往麦克风设置" }),
  );
  expect(
    await within(failure).findByText(
      "请手动前往：系统设置 → 隐私与安全 → 麦克风",
    ),
  ).toBeVisible();
  expect(openMicrophoneSettings).toHaveBeenCalledOnce();
  expect(
    within(failure).getByRole("button", { name: "前往麦克风设置" }),
  ).toBeVisible();
});

it("reports an unavailable microphone in a dialog", async () => {
  render(
    <AudioRouteFeature
      api={firstUseApi({
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "system_audio_only" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "denied" as const,
          microphones: [],
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: [],
        })),
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const testMicrophone = await screen.findByRole("button", {
    name: "测试麦克风",
  });
  await waitFor(() => expect(testMicrophone).toBeEnabled());
  await userEvent.setup().click(testMicrophone);

  const dialog = await screen.findByRole("dialog", {
    name: "麦克风测试失败",
  });
  expect(
    within(dialog).getByRole("heading", { name: "麦克风测试失败" }),
  ).toBeVisible();
  expect(
    within(dialog).getAllByText("没有麦克风权限，请在系统设置中允许访问。"),
  ).toHaveLength(1);
  expect(
    within(dialog).getByRole("button", { name: "前往麦克风设置" }),
  ).toBeVisible();
});

function AudioRouteFeature({
  api,
  onRecord,
}: {
  api: Voice2TextDesktopApi;
  onRecord?: () => void;
  [key: string]: unknown;
}) {
  const recordingPreference = useRecordingPreference();
  const refreshCapturePreflight = React.useCallback(
    (requestPermissions: boolean) =>
      api.preflightCapture({ requestPermissions, captionEnabled: true }),
    [api],
  );
  const controller = useMicrophoneTestController({
    api,
    preferredMicrophoneDeviceId: recordingPreference.microphoneDeviceId,
    refreshCapturePreflight,
  });

  return (
    <>
      <button
        type="button"
        disabled={controller.busy || controller.teardownPending}
        onClick={onRecord}
      >
        开始录制
      </button>
      <button
        type="button"
        disabled={controller.busy || controller.teardownPending}
        onClick={() => void controller.start()}
      >
        测试麦克风
      </button>
      <MicrophoneTestDialog controller={controller} />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function renderFirstUseRoute(api: Voice2TextDesktopApi) {
  return render(<AudioRouteFeature api={api} />);
}

function renderRoute(api: Voice2TextDesktopApi) {
  return render(<AudioRouteFeature api={api} />);
}

function api(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return {
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
    startMicrophoneTest: vi.fn(),
    getMicrophoneTestSnapshot: vi.fn(),
    finishMicrophoneTest: vi.fn(),
    cancelMicrophoneTest: vi.fn(),
    openMicrophoneSettings: vi.fn(async () => ({ state: "opened" as const })),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

function firstUseApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return api(overrides);
}
