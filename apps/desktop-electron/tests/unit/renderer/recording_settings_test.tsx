// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingSettingsFeature } from "../../../src/renderer/features/settings/recording-settings-feature";
import { RECORDING_PREFERENCE_STORAGE_KEY } from "../../../src/renderer/features/capture/use-recording-preference";
import type {
  CapturePreflight,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const microphones = [
  { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
  { id: "mic-usb", name: "USB 麦克风", isDefault: false },
];

const readyPreflight: CapturePreflight = {
  minimumMacosVersion: "13.0",
  systemAudioMinimumMacosVersion: "13.0",
  captureMode: "dual_track",
  systemAudioPermission: "granted",
  microphonePermission: "granted",
  microphones,
  availableBytes: 8 * 1024 ** 3,
  requiredBytes: 2 * 1024 ** 3,
  captionModelAvailable: true,
  canStart: true,
  blockingReasons: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function recordingApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return {
    preflightCapture: vi.fn(async () => readyPreflight),
    startMicrophoneTest: vi.fn(),
    getMicrophoneTestSnapshot: vi.fn(),
    finishMicrophoneTest: vi.fn(),
    cancelMicrophoneTest: vi.fn(),
    openMicrophoneSettings: vi.fn(async () => ({ state: "opened" as const })),
    getFloatingCapturePreference: vi.fn(async () => ({ enabled: false })),
    setFloatingCapturePreference: vi.fn(async (enabled: boolean) => ({
      enabled,
    })),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("recording settings", () => {
  it("keeps the saved microphone visible while loading and persists a new selection", async () => {
    window.localStorage.setItem(
      RECORDING_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        microphoneDeviceId: "mic-saved",
        microphoneName: "会议麦克风",
      }),
    );
    const pending = deferred<CapturePreflight>();
    const api = recordingApi({
      preflightCapture: vi.fn(() => pending.promise),
    });
    const user = userEvent.setup();
    const view = render(<RecordingSettingsFeature api={api} />);

    const select = screen.getByRole("combobox", { name: "默认麦克风" });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("会议麦克风");
    expect(api.preflightCapture).toHaveBeenCalledWith({
      requestPermissions: false,
      captionEnabled: true,
    });

    pending.resolve(readyPreflight);
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent("会议麦克风");
    await user.click(select);
    expect(screen.getByRole("option", { name: "跟随系统默认" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "USB 麦克风" }));

    expect(
      JSON.parse(
        window.localStorage.getItem(RECORDING_PREFERENCE_STORAGE_KEY)!,
      ),
    ).toEqual({
      version: 1,
      microphoneDeviceId: "mic-usb",
      microphoneName: "USB 麦克风",
    });
    view.unmount();

    render(<RecordingSettingsFeature api={recordingApi()} />);
    expect(
      await screen.findByRole("combobox", { name: "默认麦克风" }),
    ).toHaveTextContent("USB 麦克风");
  });

  it("recovers a local device read failure without disabling other recording settings", async () => {
    const api = recordingApi({
      preflightCapture: vi
        .fn<Voice2TextDesktopApi["preflightCapture"]>()
        .mockRejectedValueOnce(new Error("raw /private/device failure"))
        .mockResolvedValueOnce(readyPreflight),
    });
    const user = userEvent.setup();
    render(<RecordingSettingsFeature api={api} />);

    expect(await screen.findByText("无法读取麦克风，请重试。")).toBeVisible();
    expect(screen.queryByText(/private\/device/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "悬浮控制条" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "重新载入设备" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "默认麦克风" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByText("无法读取麦克风，请重试。"),
    ).not.toBeInTheDocument();
  });

  it("uses the shared microphone dialog meter and finish lifecycle", async () => {
    const running = {
      testId: "mic-test-recording-settings",
      state: "running" as const,
      elapsedMs: 1_000,
      normalizedRMS: 0.1,
      normalizedPeak: 0.5,
      observedFrames: 10,
      observedSound: true,
    };
    const finishMicrophoneTest = vi.fn(async () => ({
      ...running,
      state: "finished" as const,
      reason: "detected" as const,
    }));
    const api = recordingApi({
      startMicrophoneTest: vi.fn(async () => running),
      getMicrophoneTestSnapshot: vi.fn<
        Voice2TextDesktopApi["getMicrophoneTestSnapshot"]
      >(() => new Promise(() => undefined)),
      finishMicrophoneTest,
    });
    render(<RecordingSettingsFeature api={api} />);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "测试麦克风" }));
    const dialog = await screen.findByRole("dialog", { name: "测试麦克风" });
    expect(within(dialog).getByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "67",
    );
    expect(api.startMicrophoneTest).toHaveBeenCalledWith({
      microphoneDeviceId: "mic-default",
    });

    await user.click(within(dialog).getByRole("button", { name: "结束测试" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(finishMicrophoneTest).toHaveBeenCalledWith(running.testId);
  });

  it("cancels an active shared test once when settings unmounts", async () => {
    const running = {
      testId: "mic-test-recording-settings-cleanup",
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
    const api = recordingApi({
      startMicrophoneTest: vi.fn(async () => running),
      getMicrophoneTestSnapshot: vi.fn<
        Voice2TextDesktopApi["getMicrophoneTestSnapshot"]
      >(() => new Promise(() => undefined)),
      cancelMicrophoneTest,
    });
    const view = render(<RecordingSettingsFeature api={api} />);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "测试麦克风" }));
    await screen.findByRole("dialog", { name: "测试麦克风" });
    view.unmount();

    await waitFor(() => expect(cancelMicrophoneTest).toHaveBeenCalledOnce());
    expect(cancelMicrophoneTest).toHaveBeenCalledWith(running.testId);
  });

  it("keeps storage failures in the microphone row", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });

    render(<RecordingSettingsFeature api={recordingApi()} />);

    expect(
      await screen.findByText("无法读取已保存的麦克风，已跟随系统默认。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "悬浮控制条" })).toBeEnabled();

    getItem.mockRestore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    const user = userEvent.setup();
    const select = screen.getByRole("combobox", { name: "默认麦克风" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "USB 麦克风" }));
    expect(screen.getByText("无法保存默认麦克风，请重试。")).toBeVisible();
  });
});
