import { describe, expect, it, vi } from "vitest";

import { finalizeCommittedCaptureTranscript } from "../../src/main/domain/captions/capture_formal_completion";

const processing = {
  operationId: "asr" as const,
  resourceIdentity: "a".repeat(64),
  protocolIdentity: "desktop-sherpa-worker/v1",
  modelSha256: "b".repeat(64),
  runtimeSha256: "c".repeat(64),
};

describe("capture formal completion boundary", () => {
  it("does not turn a committed capture into a failed stop when formal handoff fails", async () => {
    const reportFailure = vi.fn();
    const publish = vi.fn();
    const handoff = {
      finalize: vi.fn(async () => {
        throw new Error("injected formal failure");
      }),
    };

    await expect(
      finalizeCommittedCaptureTranscript({
        handoff: handoff as never,
        sessionId: "session-formal-boundary-123456",
        displayName: "Committed capture",
        processing,
        publish,
        reportFailure,
      }),
    ).resolves.toBeNull();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
