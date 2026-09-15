import { describe, expect, it, vi } from "vitest";

import { finalizeCommittedCaptureTranscript } from "../../src/main/domain/captions/capture_formal_completion";

describe("capture formal completion boundary", () => {
  it("returns the authoritative library receipt without publishing it as a caption", async () => {
    const publish = vi.fn();
    const receipt = {
      sessionId: "session-media-only-123456",
      audioId: 41,
      inserted: true,
    };
    const handoff = {
      finalize: vi.fn(async () => receipt),
    };

    await expect(
      finalizeCommittedCaptureTranscript({
        handoff: handoff as never,
        sessionId: "session-media-only-123456",
        displayName: "Media only",
        processing: null,
        publish,
        reportFailure: vi.fn(),
      }),
    ).resolves.toEqual(receipt);
    expect(handoff.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ processing: null }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports projection failure without turning a committed capture into a failed stop", async () => {
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
        processing: null,
        publish,
        reportFailure,
      }),
    ).resolves.toBeNull();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
