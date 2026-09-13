import { describe, expect, it } from "vitest";

import {
  activeCaptureQuitDialog,
  captureRequiresSnapshotPolling,
  captureRequiresQuitConfirmation,
} from "../../src/main/domain/capture/capture_lifecycle_policy";
import { captureSnapshotSchema } from "../../src/shared/contracts";

describe("capture lifecycle policy", () => {
  it("makes continue recording the accessible default and never offers discard", () => {
    expect(activeCaptureQuitDialog.defaultId).toBe(0);
    expect(activeCaptureQuitDialog.cancelId).toBe(0);
    expect(activeCaptureQuitDialog.buttons[0]).toMatch(/继续录制/);
    expect(activeCaptureQuitDialog.buttons.join(" ")).not.toMatch(
      /丢弃|discard/i,
    );
    expect(activeCaptureQuitDialog.detail).toBe(
      "选择停止后，应用会先保存当前录制再退出。",
    );
    expect(activeCaptureQuitDialog.detail).not.toMatch(/日志|哈希|hash/i);
  });

  it("confirms active and paused sessions but not finalized partial authority", () => {
    const recording = snapshot({ state: "recording" });
    const paused = snapshot({ state: "paused" });
    const finalizedPartial = snapshot({
      state: "partial_capture",
      partialCapture: true,
      systemAudioHealthy: false,
      microphoneHealthy: false,
      recordingSha256: "a".repeat(64),
    });
    expect(captureRequiresQuitConfirmation(recording)).toBe(true);
    expect(captureRequiresQuitConfirmation(paused)).toBe(true);
    expect(captureRequiresQuitConfirmation(finalizedPartial)).toBe(false);
  });

  it("does not poll a recovered partial session after both tracks have stopped", () => {
    const livePartial = snapshot({
      state: "partial_capture",
      partialCapture: true,
      microphoneHealthy: false,
    });
    const recoveredTerminalPartial = snapshot({
      state: "partial_capture",
      partialCapture: true,
      systemAudioHealthy: false,
      microphoneHealthy: false,
    });

    expect(captureRequiresSnapshotPolling(livePartial)).toBe(true);
    expect(captureRequiresSnapshotPolling(recoveredTerminalPartial)).toBe(
      false,
    );
  });
});

function snapshot(overrides: Record<string, unknown>) {
  return captureSnapshotSchema.parse({
    sessionId: "session-lifecycle-123456",
    state: "recording",
    captureMode: "dual_track",
    captureTimelineMs: 1,
    systemAudioHealthy: true,
    microphoneHealthy: true,
    partialCapture: false,
    finalizedChunkCount: 0,
    eventCount: 0,
    gapCount: 0,
    interruptionReason: null,
    recordingSha256: null,
    ...overrides,
  });
}
