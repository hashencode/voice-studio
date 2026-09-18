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

describe("application activity", () => {
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

  it("admits recovery for a completed capture with an idle projection", () => {
    const state = new DesktopApplicationState();
    const capture = completedCapture(5);
    state.setCapture(capture);

    expect(
      canRetryCaptureLibraryProjection(state.snapshot(), {
        sessionId: capture.sessionId,
        intentId: "idle-recovery",
      }),
    ).toBe(true);
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

  it("keeps completed, partial, and failed capture transitions out of messages", () => {
    const state = new DesktopApplicationState();
    const completed = completedCapture(1);

    state.setCapture(completed, "private meeting title");
    const partial = {
      ...completedCapture(30),
      state: "partial_capture" as const,
      recordingSha256: "b".repeat(64),
      partialCapture: true,
      systemAudioHealthy: false,
      microphoneHealthy: false,
    };
    state.setCapture(partial);
    state.setCapture({
      ...completedCapture(31),
      state: "failed",
      recordingSha256: null,
    });

    expect(state.snapshot().activity).toEqual([]);
    expect(JSON.stringify(state.snapshot().activity)).not.toContain(
      "private meeting title",
    );
  });

  it("deduplicates admitted application failures and keeps safe fields only", () => {
    const state = new DesktopApplicationState();
    state.recordApplicationFailure({
      kind: "processing_runtime_unavailable",
      safeSummary: "本地处理组件暂不可用。",
      settingsTarget: "local-models",
    });
    const id = state.snapshot().activity![0]!.id;
    state.markActivityRead(id);
    state.recordApplicationFailure({
      kind: "processing_runtime_unavailable",
      safeSummary: "本地处理组件暂不可用。",
      settingsTarget: "local-models",
    });

    expect(state.snapshot().activity).toEqual([
      expect.objectContaining({
        id,
        kind: "processing_runtime_unavailable",
        safeSummary: "本地处理组件暂不可用。",
        occurrenceCount: 2,
        unread: true,
        settingsTarget: "local-models",
      }),
    ]);
    const serialized = JSON.stringify(state.snapshot().activity);
    expect(serialized).not.toContain("/Users/private/recording.wav");
    expect(serialized).not.toContain("private meeting title");
    expect(serialized).not.toContain("a".repeat(64));
  });

  it("keeps failures with different settings targets distinct", () => {
    const state = new DesktopApplicationState();
    for (const settingsTarget of ["local-models", "general"] as const) {
      state.recordApplicationFailure({
        kind: "processing_runtime_unavailable",
        safeSummary: "应用组件暂不可用。",
        settingsTarget,
      });
    }

    expect(state.snapshot().activity).toHaveLength(2);
    expect(
      state.snapshot().activity!.map((item) => item.settingsTarget),
    ).toEqual(["general", "local-models"]);
  });

  it("keeps distinct diagnostic causes separate and updates the latest event", () => {
    const state = new DesktopApplicationState();
    const base = {
      kind: "processing_runtime_unavailable" as const,
      safeSummary: "本地处理组件暂不可用。",
      settingsTarget: "local-models" as const,
      diagnostic: {
        eventId: "13b1980d-6874-408b-b186-fbf960dc3c1a",
        stage: "模型加载",
        code: "MODEL_LOAD_FAILED",
        reason: "模型文件校验未通过。",
        exceptionType: "ModelLoadError",
        stackFrames: ["LocalModelService.initialize"],
        appVersion: "0.1.0",
        occurredAt: 100,
      },
    };
    state.recordApplicationFailure(base);
    state.recordApplicationFailure({
      ...base,
      diagnostic: {
        ...base.diagnostic,
        eventId: "e09377e0-10cf-40c6-922a-c94d4d070430",
        occurredAt: 200,
      },
    });
    state.recordApplicationFailure({
      ...base,
      diagnostic: {
        ...base.diagnostic,
        code: "MODEL_NOT_FOUND",
        eventId: "b640799c-9454-40b8-845d-ae50c27cc2f7",
        occurredAt: 300,
      },
    });

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(2);
    expect(activity[0]!.diagnostic?.code).toBe("MODEL_NOT_FOUND");
    expect(activity[1]).toMatchObject({
      occurrenceCount: 2,
      lastOccurredAt: 200,
      diagnostic: { eventId: "e09377e0-10cf-40c6-922a-c94d4d070430" },
    });
  });

  it("keeps distinct failures newest-first, caps at 30, and reads idempotently", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 32; index += 1) {
      state.recordApplicationFailure({
        kind: "startup_reconciliation_failed",
        safeSummary: `启动恢复暂未完成 ${index}`,
        settingsTarget: null,
      });
    }

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(30);
    expect(activity[0]!.safeSummary).toBe("启动恢复暂未完成 31");
    expect(activity.at(-1)!.safeSummary).toBe("启动恢复暂未完成 2");
    const beforeIds = activity.map((item) => item.id);
    const revision = state.snapshot().revision;

    state.markActivityRead(activity[1]!.id);
    expect(state.snapshot().activity![1]!.unread).toBe(false);
    expect(state.snapshot().revision).toBe(revision + 1);
    state.markActivityRead(activity[1]!.id);
    state.markActivityRead("unknown-activity");
    expect(state.snapshot().revision).toBe(revision + 1);

    state.markAllActivityRead();
    expect(state.snapshot().activity!.every((item) => !item.unread)).toBe(true);
    expect(state.snapshot().activity!.map((item) => item.id)).toEqual(
      beforeIds,
    );
    const allReadRevision = state.snapshot().revision;
    state.markAllActivityRead();
    expect(state.snapshot().revision).toBe(allReadRevision);
  });

  it("evicts the oldest read failure before an older unread failure", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 30; index += 1) {
      state.recordApplicationFailure({
        kind: "startup_reconciliation_failed",
        safeSummary: `启动恢复暂未完成 ${index}`,
        settingsTarget: null,
      });
    }
    const oldestRead = state.snapshot().activity![20]!;
    state.markActivityRead(oldestRead.id);

    state.recordApplicationFailure({
      kind: "startup_reconciliation_failed",
      safeSummary: "启动恢复暂未完成 30",
      settingsTarget: null,
    });

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(30);
    expect(activity[0]!.safeSummary).toBe("启动恢复暂未完成 30");
    expect(activity.map((item) => item.id)).not.toContain(oldestRead.id);
    expect(activity.at(-1)!.safeSummary).toBe("启动恢复暂未完成 0");
  });

  it("refreshes an existing failure at capacity without evicting another item", () => {
    const state = new DesktopApplicationState();
    for (let index = 0; index < 30; index += 1) {
      state.recordApplicationFailure({
        kind: "startup_reconciliation_failed",
        safeSummary: `启动恢复暂未完成 ${index}`,
        settingsTarget: null,
      });
    }
    const target = state.snapshot().activity![10]!;
    const idsBefore = state.snapshot().activity!.map((item) => item.id);
    state.markActivityRead(target.id);

    state.recordApplicationFailure({
      kind: target.kind,
      safeSummary: target.safeSummary,
      settingsTarget: target.settingsTarget,
    });

    const activity = state.snapshot().activity!;
    expect(activity).toHaveLength(30);
    expect(activity[0]).toMatchObject({
      id: target.id,
      occurrenceCount: 2,
      unread: true,
    });
    expect(new Set(activity.map((item) => item.id))).toEqual(
      new Set(idsBefore),
    );
  });
});
