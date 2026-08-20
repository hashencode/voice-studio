import { describe, expect, it } from "vitest";

import { DesktopApplicationState } from "../../src/main/application/application_state";
import type { CaptureSnapshot } from "../../src/shared/contracts";

function completedCapture(index: number): CaptureSnapshot {
  return {
    sessionId: `session-activity-${String(index).padStart(4, "0")}`,
    state: "completed",
    captureMode: "dual_track",
    captureTimelineMs: index * 1_000,
    systemAudioHealthy: true,
    microphoneHealthy: true,
    partialCapture: false,
    finalizedChunkCount: 1,
    eventCount: 1,
    gapCount: 0,
    interruptionReason: null,
    recordingSha256: "a".repeat(64),
  };
}

describe("application capture activity", () => {
  it("adds one privacy-safe item for the first durable terminal transition", () => {
    const state = new DesktopApplicationState();
    const completed = completedCapture(1);

    state.setCapture(completed, "private meeting title");
    state.setCapture(completed, "private meeting title");

    expect(state.snapshot().activity).toEqual([
      expect.objectContaining({
        id: `${completed.sessionId}:capture_completed`,
        captureSessionId: completed.sessionId,
        title: "录制已保存",
        read: false,
      }),
    ]);
    expect(JSON.stringify(state.snapshot().activity)).not.toContain(
      "private meeting title",
    );
  });

  it("retains the newest 20 items and acknowledges only through the target", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 22; index += 1) {
      state.setCapture(completedCapture(index));
    }

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(20);
    expect(activity[0]!.captureSessionId).toBe("session-activity-0021");
    expect(activity.at(-1)!.captureSessionId).toBe("session-activity-0002");

    const revision = state.snapshot().revision;
    state.acknowledgeActivity(activity[1]!.id);
    expect(
      state
        .snapshot()
        .activity!.map((item) => item.read)
        .slice(0, 3),
    ).toEqual([false, true, true]);
    expect(state.snapshot().revision).toBe(revision + 1);
    state.acknowledgeActivity(activity[1]!.id);
    expect(state.snapshot().revision).toBe(revision + 1);
  });

  it("publishes durable partial and failed capture activity only once", () => {
    const state = new DesktopApplicationState();
    const partial = {
      ...completedCapture(30),
      state: "partial_capture" as const,
      recordingSha256: null,
      partialCapture: true,
      systemAudioHealthy: false,
      microphoneHealthy: false,
    };
    state.setCapture(partial);
    expect(state.snapshot().activity).toEqual([]);

    state.setCapture({ ...partial, recordingSha256: "b".repeat(64) });
    state.setCapture({ ...partial, recordingSha256: "b".repeat(64) });
    expect(state.snapshot().activity).toEqual([
      expect.objectContaining({
        kind: "capture_partial",
        severity: "warning",
        resolved: false,
      }),
    ]);

    state.setCapture({
      ...completedCapture(31),
      state: "failed",
      recordingSha256: null,
    });
    expect(state.snapshot().activity?.[0]).toEqual(
      expect.objectContaining({ kind: "capture_failed", resolved: false }),
    );
  });
});
