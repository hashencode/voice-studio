import { describe, expect, it, vi } from "vitest";

import {
  microphonePrivacySettingsUri,
  openMicrophoneSettings,
  privacyAndSecuritySettingsUri,
} from "../../src/main/domain/capture/microphone_settings";

describe("microphone settings intent", () => {
  it("opens the fixed microphone pane without calling fallback", async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(openMicrophoneSettings(openExternal)).resolves.toEqual({
      state: "opened",
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(microphonePrivacySettingsUri);
  });

  it("falls back to Privacy & Security and returns a typed final failure", async () => {
    const fallback = vi
      .fn<(uri: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("deep link unavailable"))
      .mockResolvedValueOnce(undefined);
    await expect(openMicrophoneSettings(fallback)).resolves.toEqual({
      state: "opened",
    });
    expect(fallback).toHaveBeenNthCalledWith(1, microphonePrivacySettingsUri);
    expect(fallback).toHaveBeenNthCalledWith(2, privacyAndSecuritySettingsUri);

    const failed = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await expect(openMicrophoneSettings(failed)).resolves.toEqual({
      state: "failed",
    });
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
