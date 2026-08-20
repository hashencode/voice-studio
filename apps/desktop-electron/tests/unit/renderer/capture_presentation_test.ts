import { describe, expect, it } from "vitest";

import {
  deriveCaptureCompactPresentation,
  formatCaptureElapsed,
} from "../../../src/renderer/features/capture/capture-presentation";
import type { ApplicationSnapshot } from "../../../src/shared/contracts";

type Capture = ApplicationSnapshot["capture"];

function capture(
  phase: Exclude<Capture["phase"], "idle">,
  values: Partial<Exclude<Capture, { phase: "idle" }>> = {},
): Exclude<Capture, { phase: "idle" }> {
  return {
    phase,
    sessionId: "capture-1",
    title: "private title",
    elapsedMs: 65_000,
    ...values,
  } as Exclude<Capture, { phase: "idle" }>;
}

describe("capture compact presentation", () => {
  it("keeps the compact model privacy-safe and action-specific", () => {
    expect(deriveCaptureCompactPresentation(capture("recording"))).toEqual({
      sessionId: "capture-1",
      phase: "recording",
      status: "录制中",
      elapsed: "01:05",
      action: "pause",
      canStop: true,
      needsAttention: false,
      indicator: null,
    });
    expect(
      JSON.stringify(deriveCaptureCompactPresentation(capture("recording"))),
    ).not.toContain("private title");
  });

  it("maps paused, finalizing, and terminal attention without inventing state", () => {
    expect(deriveCaptureCompactPresentation(capture("paused"))?.action).toBe(
      "resume",
    );
    expect(
      deriveCaptureCompactPresentation(capture("finalizing")),
    ).toMatchObject({ action: null, canStop: false, status: "保存中" });
    expect(deriveCaptureCompactPresentation(capture("failed"))).toMatchObject({
      needsAttention: true,
      canStop: false,
    });
    expect(
      deriveCaptureCompactPresentation(
        capture("partial_capture", {
          systemAudioHealthy: true,
          microphoneHealthy: false,
        }),
      ),
    ).toMatchObject({ action: "pause", canStop: true, indicator: "部分轨道" });
  });

  it("does not show idle or completed captures in compact controls", () => {
    expect(deriveCaptureCompactPresentation({ phase: "idle" })).toBeNull();
    expect(deriveCaptureCompactPresentation(capture("completed"))).toBeNull();
  });

  it("formats long recordings without wrapping minutes past an hour", () => {
    expect(formatCaptureElapsed(3_661_000)).toBe("01:01:01");
  });
});
