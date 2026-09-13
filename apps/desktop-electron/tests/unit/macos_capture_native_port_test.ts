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
    [
      new NativeHelperCommandError(
        "CAPTURE_FINALIZATION_FAILED",
        "finalization failed",
      ),
      "finalization",
    ],
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

  it("recreates after discard transport loss without replaying the mutation", async () => {
    const first = sessionFixture();
    const replacement = sessionFixture();
    first.captureDiscard.mockRejectedValueOnce(
      new NativeHelperResponseError("discard response lost"),
    );
    const reopen = vi.fn(async () =>
      Promise.resolve(replacement as unknown as MacOSNativeHelperSession),
    );
    const port = new MacOSCaptureNativePort(
      first as unknown as MacOSNativeHelperSession,
      reopen,
    );

    await expect(
      port.discard("session-discard-port-123456", "discard-port-123456"),
    ).rejects.toBeInstanceOf(NativeHelperResponseError);
    expect(first.captureDiscard).toHaveBeenCalledOnce();
    expect(first.abort).toHaveBeenCalledOnce();
    expect(reopen).toHaveBeenCalledOnce();
    expect(replacement.captureDiscard).not.toHaveBeenCalled();
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

  it("joins concurrent native-session recreation requests", async () => {
    const first = sessionFixture();
    const replacement = sessionFixture();
    let resolveReplacement!: (session: MacOSNativeHelperSession) => void;
    const replacementPending = new Promise<MacOSNativeHelperSession>(
      (resolve) => {
        resolveReplacement = resolve;
      },
    );
    const reopen = vi.fn(() => replacementPending);
    const port = new MacOSCaptureNativePort(
      first as unknown as MacOSNativeHelperSession,
      reopen,
    );

    const firstRequest = port.recreateAfterTransportLoss();
    const secondRequest = port.recreateAfterTransportLoss();
    expect(first.abort).toHaveBeenCalledOnce();
    expect(reopen).toHaveBeenCalledOnce();
    resolveReplacement(replacement as unknown as MacOSNativeHelperSession);

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(port.currentSession()).toBe(replacement);
  });
});

function sessionFixture() {
  return {
    captureControl: vi.fn(),
    captureRecover: vi.fn(),
    captureDiscard: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}
