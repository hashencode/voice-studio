import { describe, expect, it } from "vitest";

import {
  DesktopApplicationState,
  canRetryCaptureLibraryProjection,
} from "../../src/main/application/application_state";
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
  it("publishes a fenced live library projection lifecycle", () => {
    const state = new DesktopApplicationState();
    const sessionId = "session-projection-123456";
    const intentId = "intent-projection-123456";
    const phases: string[] = [];
    state.subscribe((snapshot) => {
      if (snapshot.libraryProjection) {
        phases.push(snapshot.libraryProjection.phase);
      }
    });

    state.setCapture(completedCapture(1));
    state.beginCaptureLibraryProjection({ sessionId, intentId });
    expect(state.snapshot().libraryProjection).toEqual({
      phase: "registering",
      sessionId,
      intentId,
    });

    state.completeCaptureLibraryProjection({
      sessionId,
      intentId,
      audioId: 7,
    });
    expect(state.snapshot().libraryProjection).toEqual({
      phase: "registered",
      sessionId,
      intentId,
      audioId: 7,
    });
    expect(phases.slice(-2)).toEqual(["registering", "registered"]);

    const registered = state.snapshot();
    state.completeCaptureLibraryProjection({
      sessionId,
      intentId,
      audioId: 7,
    });
    state.failCaptureLibraryProjection({
      sessionId,
      intentId: "stale-intent-123456",
      code: "commit_failed",
    });
    expect(state.snapshot()).toEqual(registered);
  });

  it("does not create a live projection intent while library count changes", () => {
    const state = new DesktopApplicationState();

    state.setLibraryCount(2);
    const revision = state.snapshot().revision;
    state.setLibraryCount(2);

    expect(state.snapshot().libraryProjection).toEqual({ phase: "idle" });
    expect(state.snapshot().revision).toBe(revision);
  });

  it("keeps projection failures safe and rejects invalid registered audio IDs", () => {
    const state = new DesktopApplicationState();
    const command = {
      sessionId: "session-projection-failed-123456",
      intentId: "intent-projection-failed-123456",
    };

    state.beginCaptureLibraryProjection(command);
    state.failCaptureLibraryProjection({ ...command, code: "commit_failed" });
    expect(state.snapshot().libraryProjection).toEqual({
      phase: "failed",
      ...command,
      code: "commit_failed",
      message: "录音已保存，但暂时无法加入音频资料库。请重试。",
    });
    expect(JSON.stringify(state.snapshot().libraryProjection)).not.toContain(
      "/Users/private/recording.wav",
    );

    state.beginCaptureLibraryProjection(command);
    expect(() =>
      state.completeCaptureLibraryProjection({ ...command, audioId: 0 }),
    ).toThrow();
  });

  it("admits retry only for the matching failed intent and terminal capture", () => {
    const state = new DesktopApplicationState();
    const capture = completedCapture(4);
    const request = {
      sessionId: capture.sessionId,
      intentId: "intent-retry-123456",
    };
    state.setCapture(capture);
    state.beginCaptureLibraryProjection(request);
    state.failCaptureLibraryProjection({ ...request, code: "commit_failed" });
    const failed = state.snapshot();

    expect(canRetryCaptureLibraryProjection(failed, request)).toBe(true);
    expect(
      canRetryCaptureLibraryProjection(failed, {
        ...request,
        intentId: "stale-intent-123456",
      }),
    ).toBe(false);
    expect(
      canRetryCaptureLibraryProjection(
        { ...failed, capture: { phase: "idle" } },
        request,
      ),
    ).toBe(false);
    expect(state.snapshot()).toEqual(failed);
  });

  it("resets the previous projection when a new capture lifecycle begins", () => {
    const state = new DesktopApplicationState();
    const command = {
      sessionId: "session-projection-reset-123456",
      intentId: "intent-projection-reset-123456",
    };
    state.beginCaptureLibraryProjection(command);
    state.completeCaptureLibraryProjection({ ...command, audioId: 42 });

    state.resetCaptureLibraryProjection();

    expect(state.snapshot().libraryProjection).toEqual({ phase: "idle" });
  });

  it("projects the soft stop threshold as a continuing save", () => {
    const state = new DesktopApplicationState();
    state.setCapture({
      ...completedCapture(0),
      state: "finalizing",
      recordingSha256: null,
      interruptionReason: "capture_stop_slow",
    });

    expect(state.snapshot().capture).toMatchObject({
      phase: "finalizing",
      interruptionReason: "capture_stop_slow",
      message: "保存时间比预期长，仍在继续保存…",
    });
  });

  it("discards navigation until the application profile is ready", () => {
    const state = new DesktopApplicationState();
    const initial = state.snapshot();

    expect(state.navigate("settings")).toEqual(initial);
    state.completeBootstrap({
      status: "blocked",
      code: "filesystem_unavailable",
      message: "blocked",
      repairable: true,
    });
    const blocked = state.snapshot();
    expect(state.navigate("companion")).toEqual(blocked);
    expect(state.snapshot().navigation.section).toBe("library");
  });

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

  it("retains the newest 20 items and marks exactly one item read", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 22; index += 1) {
      state.setCapture(completedCapture(index));
    }

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(20);
    expect(activity[0]!.captureSessionId).toBe("session-activity-0021");
    expect(activity.at(-1)!.captureSessionId).toBe("session-activity-0002");

    const revision = state.snapshot().revision;
    state.markActivityRead(activity[1]!.id);
    expect(
      state
        .snapshot()
        .activity!.map((item) => item.read)
        .slice(0, 3),
    ).toEqual([false, true, false]);
    expect(state.snapshot().revision).toBe(revision + 1);
    state.markActivityRead(activity[1]!.id);
    state.markActivityRead("unknown-activity");
    expect(state.snapshot().revision).toBe(revision + 1);
  });

  it("marks all activity read idempotently without changing order", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 3; index += 1) {
      state.setCapture(completedCapture(index));
    }
    const before = state.snapshot().activity!.map((item) => item.id);
    const revision = state.snapshot().revision;

    state.markAllActivityRead();
    expect(state.snapshot().activity!.every((item) => item.read)).toBe(true);
    expect(state.snapshot().activity!.map((item) => item.id)).toEqual(before);
    expect(state.snapshot().revision).toBe(revision + 1);
    state.markAllActivityRead();
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
