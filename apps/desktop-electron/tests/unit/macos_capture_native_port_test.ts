import { describe, expect, it, vi } from "vitest";

import {
  CaptureNativeStopError,
  type CaptureNativeStopFailureKind,
} from "../../src/main/domain/capture/capture_native_port";
import { MacOSCaptureNativePort } from "../../src/main/domain/capture/macos_capture_native_port";
import {
  NativeHelperCommandError,
  NativeHelperResponseError,
  type MacOSNativeHelperSession,
} from "../../src/main/features/importing/macos_native_helper_client";

describe("MacOSCaptureNativePort stop lifecycle", () => {
  it.each([
    [new NativeHelperCommandError("CAPTURE_BUSY", "busy"), "command"],
    [new NativeHelperResponseError("response lost"), "transport"],
  ] as const)("classifies %s as %s", async (failure, expectedKind) => {
    const session = sessionFixture();
    session.captureControl.mockRejectedValueOnce(failure);
    const port = new MacOSCaptureNativePort(
      session as unknown as MacOSNativeHelperSession,
    );

    const error = await port
      .stop({
        action: "stop",
        sessionId: "session-port-stop-123456",
        idempotencyKey: "stop-port-123456",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CaptureNativeStopError);
    expect((error as CaptureNativeStopError).kind).toBe(
      expectedKind satisfies CaptureNativeStopFailureKind,
    );
  });

  it("aborts the lost session before atomically replacing it", async () => {
    const first = sessionFixture();
    const replacement = sessionFixture();
    replacement.captureRecover.mockResolvedValueOnce([]);
    const reopen = vi.fn(async () =>
      Promise.resolve(replacement as unknown as MacOSNativeHelperSession),
    );
    const port = new MacOSCaptureNativePort(
      first as unknown as MacOSNativeHelperSession,
      reopen,
    );

    await port.recreateAfterTransportLoss();
    await port.recover();

    expect(first.abort).toHaveBeenCalledOnce();
    expect(reopen).toHaveBeenCalledOnce();
    expect(port.currentSession()).toBe(replacement);
    expect(replacement.captureRecover).toHaveBeenCalledOnce();
    expect(first.captureRecover).not.toHaveBeenCalled();

    await port.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });
});

function sessionFixture() {
  return {
    captureControl: vi.fn(),
    captureRecover: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}
