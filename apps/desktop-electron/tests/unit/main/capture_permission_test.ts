import { describe, expect, it, vi } from "vitest";

import { requestMicrophonePermissionIfNeeded } from "../../../src/main/domain/capture/capture_permission";

describe("capture microphone permission", () => {
  it("requests undetermined permission from the foreground app authority", async () => {
    const askForMediaAccess = vi.fn(async () => true);

    await requestMicrophonePermissionIfNeeded({
      getMediaAccessStatus: vi.fn(() => "not-determined"),
      askForMediaAccess,
    });

    expect(askForMediaAccess).toHaveBeenCalledOnce();
    expect(askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it.each(["granted", "denied", "restricted", "unknown"])(
    "does not re-prompt when permission is %s",
    async (status) => {
      const askForMediaAccess = vi.fn(async () => true);

      await requestMicrophonePermissionIfNeeded({
        getMediaAccessStatus: vi.fn(() => status),
        askForMediaAccess,
      });

      expect(askForMediaAccess).not.toHaveBeenCalled();
    },
  );

  it("surfaces prompt failures instead of waiting in the helper", async () => {
    const failure = new Error("permission prompt unavailable");

    await expect(
      requestMicrophonePermissionIfNeeded({
        getMediaAccessStatus: vi.fn(() => "not-determined"),
        askForMediaAccess: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
  });
});
