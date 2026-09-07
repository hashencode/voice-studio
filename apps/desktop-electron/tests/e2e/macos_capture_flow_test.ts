import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DesktopCaptureService,
  localCaptureDay,
} from "../../src/main/domain/capture/desktop_capture_service";
import {
  CaptureQuitCoordinator,
  type CaptureQuitCoordinatorPorts,
  type QuitDecision,
} from "../../src/main/domain/capture/capture_quit_coordinator";
import { finalizeCommittedCaptureTranscript } from "../../src/main/domain/captions/capture_formal_completion";
import type { CaptureNativePort } from "../../src/main/domain/capture/capture_native_port";
import { CaptureNativeStopError } from "../../src/main/domain/capture/capture_native_port";
import { MicrophoneTestService } from "../../src/main/domain/capture/microphone_test_service";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { CaptureRepository } from "../../src/main/storage/repositories/capture_repository";
import {
  captureRuntimeSnapshotSchema,
  captureSnapshotSchema,
  desktopCaptureParitySchema,
  type CaptureSnapshot,
  type CaptureRuntimeSnapshot,
  type MicrophoneTestSnapshot,
} from "../../src/shared/contracts/capture";

const parity = desktopCaptureParitySchema.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../fixtures/flutter-reference/desktop_capture_v1.json",
      ),
      "utf8",
    ),
  ),
);

describe("macOS capture parity flow", () => {
  it("keeps runtime activity out of durable snapshots and command receipts", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    native.start.mockResolvedValueOnce(
      runtimeSnapshot({
        sessionId: "session-activity-123456",
        audioActivity: 0.72,
      }),
    );
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
    );
    try {
      const result = await service.start({
        sessionId: "session-activity-123456",
        title: "Activity",
        idempotencyKey: "start-activity-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(service.audioActivity()).toBe(0.72);
      expect(JSON.stringify(result)).not.toContain("audioActivity");
      expect(
        JSON.stringify(
          repository.receipt(
            "session-activity-123456",
            "start-activity-123456",
          ),
        ),
      ).not.toContain("audioActivity");

      native.snapshot.mockRejectedValueOnce(new Error("runtime refresh lost"));
      await expect(service.refresh("session-activity-123456")).rejects.toThrow(
        "runtime refresh lost",
      );
      expect(service.audioActivity()).toBe(0);
      expect(service.snapshot()).toMatchObject({
        sessionId: "session-activity-123456",
        state: "recording",
        captureTimelineMs: 1_000,
      });

      native.snapshot.mockResolvedValueOnce(
        runtimeSnapshot({
          sessionId: "session-activity-123456",
          captureTimelineMs: 1_500,
          audioActivity: 0.44,
        }),
      );
      await service.refresh("session-activity-123456");
      expect(service.audioActivity()).toBe(0.44);
    } finally {
      database.close();
    }
  });
  it("suggests the next persisted session number without reserving it", () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const nowMs = new Date(2026, 6, 1, 12).getTime();
    const service = new DesktopCaptureService(
      repository,
      nativeFixture(),
      "/tmp/voice2text-capture-test-root",
      () => nowMs,
    );
    try {
      expect(service.suggestCaptureTitle()).toEqual({
        title: "新录音2026070101",
      });
      expect(service.suggestCaptureTitle()).toEqual({
        title: "新录音2026070101",
      });

      for (let index = 0; index < 100; index += 1) {
        repository.beginSession({
          sessionId: `session-count-${String(index).padStart(12, "0")}`,
          title: `录音 ${index}`,
          workspacePath: `/tmp/capture-${index}`,
          nowMs,
        });
        if (index === 0) {
          expect(service.suggestCaptureTitle().title).toBe("新录音2026070102");
        } else if (index === 98) {
          expect(service.suggestCaptureTitle().title).toBe("新录音20260701100");
        } else if (index === 99) {
          expect(service.suggestCaptureTitle().title).toBe("新录音20260701101");
        }
      }
    } finally {
      database.close();
    }
  });

  it("recomputes only an untouched suggestion at the formal local-day start", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    let nowMs = new Date(2026, 6, 1, 23, 59, 59, 999).getTime();
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => nowMs,
    );
    try {
      const preview = service.suggestCaptureTitle().title;
      expect(preview).toBe("新录音2026070101");
      nowMs = new Date(2026, 6, 2, 0, 0, 0, 1).getTime();
      await service.start(
        {
          sessionId: "session-midnight-123456",
          title: preview,
          idempotencyKey: "start-midnight-123456",
          minimumFreeBytes: 1,
          captionEnabled: false,
        },
        { refreshSuggestedTitle: true },
      );
      expect(service.sessionTitle("session-midnight-123456")).toBe(
        "新录音2026070201",
      );

      await service.start({
        sessionId: "session-manual-12345678",
        title: "跨日采访",
        idempotencyKey: "start-manual-12345678",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(service.sessionTitle("session-manual-12345678")).toBe("跨日采访");

      await service.start({
        sessionId: "session-manual-preview-123456",
        title: preview,
        idempotencyKey: "start-manual-preview-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(service.sessionTitle("session-manual-preview-123456")).toBe(
        preview,
      );

      const localDay = localCaptureDay(nowMs);
      expect(localDay.startMs).toBe(new Date(2026, 6, 2).getTime());
      expect(localDay.endMs).toBe(new Date(2026, 6, 3).getTime());
      expect(localDay.dateStamp).toBe("20260702");

      const januaryOffset = new Date(2026, 0, 1).getTimezoneOffset();
      const julyOffset = new Date(2026, 6, 1).getTimezoneOffset();
      if (januaryOffset !== julyOffset) {
        const transitionMonth = januaryOffset > julyOffset ? 2 : 10;
        const lengths = Array.from({ length: 31 }, (_, index) =>
          localCaptureDay(
            new Date(2026, transitionMonth, index + 1, 12).getTime(),
          ),
        ).map((value) => value.endMs - value.startMs);
        expect(lengths.some((length) => length !== 24 * 60 * 60 * 1_000)).toBe(
          true,
        );
      }
    } finally {
      database.close();
    }
  });

  it("renames only the current editable session and preserves storage failures", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const service = new DesktopCaptureService(
      repository,
      nativeFixture(),
      "/tmp/voice2text-capture-test-root",
      () => 9_000,
    );
    try {
      const started = await service.start({
        sessionId: "session-rename-12345678",
        title: "旧标题",
        idempotencyKey: "start-rename-12345678",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(service.renameSession(started.sessionId, "  新标题  ")).toEqual(
        expect.objectContaining({ title: "新标题" }),
      );
      expect(service.sessionTitle(started.sessionId)).toBe("新标题");
      await expect(
        Promise.resolve().then(() =>
          service.renameSession("session-stale-12345678", "越权标题"),
        ),
      ).rejects.toThrow(/current capture session/);

      database.exec(`CREATE TRIGGER reject_capture_title_update
        BEFORE UPDATE OF title ON capture_sessions
        BEGIN SELECT RAISE(ABORT, 'title storage failed'); END`);
      expect(() =>
        service.renameSession(started.sessionId, "保存失败"),
      ).toThrow(/title storage failed/);
      expect(service.sessionTitle(started.sessionId)).toBe("新标题");
    } finally {
      database.close();
    }
  });

  it("persists the recovery prefix once and exposes stored recovery titles", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    const sessionId = "session-recovery-title-123456";
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 10_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      await service.start({
        sessionId,
        title: "客户访谈",
        idempotencyKey: "start-recovery-title-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      native.recover.mockResolvedValue([
        snapshot({
          sessionId,
          state: "recoverable",
          finalizedChunkCount: 1,
          journalSha256: "e".repeat(64),
        }),
      ]);

      await service.recover();
      expect(service.listRecoveries()[0]?.title).toBe("Recover-客户访谈");
      service.renameSession(sessionId, "客户访谈（已检查）");
      await service.recover();
      expect(service.listRecoveries()[0]?.title).toBe("客户访谈（已检查）");

      const restarted = new DesktopCaptureService(
        repository,
        native,
        "/tmp/voice2text-capture-test-root",
        () => 11_000,
        async (options) => authorityFixture(options.sessionId),
      );
      await restarted.recover();
      expect(restarted.sessionTitle(sessionId)).toBe("客户访谈（已检查）");
    } finally {
      database.close();
    }
  });

  it("keeps a recoverable microphone snapshot running through the Electron service", async () => {
    const native = nativeFixture();
    native.microphoneTestSnapshot.mockImplementationOnce(async (testId) => ({
      ...microphoneTestSnapshot(testId, "running"),
      elapsedMs: 750,
      normalizedRMS: 0.08,
      normalizedPeak: 0.4,
      observedFrames: 8_192,
      observedSound: true,
    }));
    const service = new MicrophoneTestService(native);

    const started = await service.start({
      ownerId: 21,
      microphoneDeviceId: "bluetooth-microphone",
    });
    const recovered = await service.snapshot({
      ownerId: 21,
      testId: started.testId,
    });

    expect(recovered).toEqual(
      expect.objectContaining({
        state: "running",
        observedFrames: 8_192,
        observedSound: true,
      }),
    );
    await service.stopForOwner(21);
    expect(native.cancelMicrophoneTest).toHaveBeenCalledOnce();
  });

  it("persists idempotent controls and commits only after native finalization", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    const service = new DesktopCaptureService(
      new CaptureRepository(database),
      native,
      "/tmp/voice2text-capture-test-root",
      () => 1_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      const preflight = await service.preflight({
        minimumFreeBytes: 128 * 1024 * 1024,
        captionModelAvailable: false,
        requestPermissions: false,
      });
      expect(preflight.blockingReasons).toContain(
        parity.preflightBranches.captionUnavailable,
      );

      const started = await service.start({
        sessionId: "session-capture-123456",
        title: "产品周会",
        idempotencyKey: "start-capture-123456",
        minimumFreeBytes: 128 * 1024 * 1024,
        captionEnabled: false,
      });
      expect(started.state).toBe("recording");
      const paused = await service.control({
        action: "pause",
        sessionId: started.sessionId,
        idempotencyKey: "pause-capture-123456",
      });
      expect(paused.state).toBe("paused");
      const resumed = await service.control({
        action: "resume",
        sessionId: started.sessionId,
        idempotencyKey: "resume-capture-123456",
      });
      expect(resumed.state).toBe("recording");
      const slept = await service.lifecycle(
        "system-sleep",
        started.sessionId,
        "system-sleep-123456",
      );
      const repeatedSleep = await service.lifecycle(
        "system-sleep",
        started.sessionId,
        "system-sleep-123456",
      );
      expect(slept.interruptionReason).toBe("system_sleep");
      expect(repeatedSleep).toEqual(slept);
      expect(native.systemSleep).toHaveBeenCalledOnce();
      const woke = await service.lifecycle(
        "system-wake",
        started.sessionId,
        "system-wake-123456",
      );
      expect(woke).toEqual(
        expect.objectContaining({
          state: "paused",
          interruptionReason: "system_wake_requires_resume",
        }),
      );
      await service.lifecycle(
        "system-sleep",
        started.sessionId,
        service.nextLifecycleIdempotencyKey("system-sleep", started.sessionId),
      );
      await service.lifecycle(
        "system-wake",
        started.sessionId,
        service.nextLifecycleIdempotencyKey("system-wake", started.sessionId),
      );
      expect(native.systemSleep).toHaveBeenCalledTimes(2);
      expect(native.systemWake).toHaveBeenCalledTimes(2);
      await service.control({
        action: "resume",
        sessionId: started.sessionId,
        idempotencyKey: "resume-after-wake-123456",
      });
      const stopped = await service.stopAndReconcile({
        action: "stop",
        sessionId: started.sessionId,
        idempotencyKey: "stop-capture-123456",
      });
      const repeated = await service.stopAndReconcile({
        action: "stop",
        sessionId: started.sessionId,
        idempotencyKey: "stop-capture-123456",
      });
      expect(stopped).toMatchObject({
        capability: "recovered-terminal",
        snapshot: { state: "completed" },
      });
      expect(repeated.snapshot).toEqual(stopped.snapshot);
      expect(native.stop).toHaveBeenCalledOnce();
      expect(service.snapshot()?.recordingSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM capture_tracks").get()
          ?.count,
      ).toBe(1);
      await expect(
        service.start({
          sessionId: started.sessionId,
          title: "冲突的重启",
          idempotencyKey: "different-start-123456",
          minimumFreeBytes: 1,
          captionEnabled: false,
        }),
      ).rejects.toThrow(/idempotency conflict/);
      expect(native.start).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("keeps the latest title through start, controls, final handoff, and restart", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    const nowMs = new Date(2026, 8, 5, 9).getTime();
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => nowMs,
      async (options) => authorityFixture(options.sessionId),
    );
    const sessionId = "session-capture-123456";
    try {
      const suggested = service.suggestCaptureTitle().title;
      const started = await service.start(
        {
          sessionId,
          title: suggested,
          idempotencyKey: "start-title-flow-123456",
          minimumFreeBytes: 1,
          captionEnabled: false,
        },
        { refreshSuggestedTitle: true },
      );
      service.renameSession(sessionId, "客户回访最终版");
      await service.control({
        action: "pause",
        sessionId,
        idempotencyKey: "pause-title-flow-123456",
      });
      await service.control({
        action: "resume",
        sessionId,
        idempotencyKey: "resume-title-flow-123456",
      });
      const stopped = await service.control({
        action: "stop",
        sessionId,
        idempotencyKey: "stop-title-flow-123456",
      });
      expect(started.sessionId).toBe(sessionId);
      expect(stopped.state).toBe("completed");

      const handoff = { finalize: vi.fn(async () => null) };
      await finalizeCommittedCaptureTranscript({
        handoff: handoff as never,
        sessionId,
        displayName: service.sessionTitle(sessionId),
        processing: null,
        publish: vi.fn(),
        reportFailure: vi.fn(),
      });
      expect(handoff.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          displayName: "客户回访最终版",
        }),
      );

      const restarted = new DesktopCaptureService(
        repository,
        native,
        "/tmp/voice2text-capture-test-root",
        () => nowMs + 1,
      );
      expect(restarted.sessionTitle(sessionId)).toBe("客户回访最终版");
    } finally {
      database.close();
    }
  });

  it("preserves one healthy track, visible gaps, and recoverable authority", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.start.mockResolvedValueOnce(
      runtimeSnapshot({
        sessionId: "session-partial-123456",
        state: "partial_capture",
        systemAudioHealthy: true,
        microphoneHealthy: false,
        partialCapture: true,
        gapCount: 1,
      }),
    );
    const service = new DesktopCaptureService(
      new CaptureRepository(database),
      native,
      "/tmp/voice2text-capture-test-root",
      () => 2_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      const result = await service.start({
        sessionId: "session-partial-123456",
        title: "部分轨道音频",
        idempotencyKey: "start-partial-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(result).toEqual(
        expect.objectContaining({
          state: parity.healthyTrackFailure.state,
          partialCapture: true,
          systemAudioHealthy: true,
          microphoneHealthy: false,
          gapCount: 1,
        }),
      );
      native.recover.mockResolvedValueOnce([
        snapshot({
          sessionId: result.sessionId,
          state: "recoverable",
          partialCapture: true,
          finalizedChunkCount: 1,
          journalSha256: "b".repeat(64),
        }),
      ]);
      await expect(service.recover()).resolves.toHaveLength(1);
      expect(service.listRecoveries()[0]).toEqual(
        expect.objectContaining({ sessionId: result.sessionId }),
      );
      await service.discardRecovered(
        result.sessionId,
        "discard-partial-123456",
      );
      await service.discardRecovered(
        result.sessionId,
        "discard-partial-123456",
      );
      expect(native.discard).toHaveBeenCalledOnce();
      expect(service.listRecoveries()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps validated recovery once and fences the same durable receipt", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.recover.mockResolvedValueOnce([
      snapshot({
        sessionId: "session-keep-123456789",
        state: "recoverable",
        partialCapture: true,
        finalizedChunkCount: 1,
        journalSha256: "c".repeat(64),
      }),
    ]);
    const service = new DesktopCaptureService(
      new CaptureRepository(database),
      native,
      "/tmp/voice2text-capture-test-root",
      () => 3_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      await service.recover();
      expect(service.listRecoveries()[0]?.title).toMatch(/^Recover-新录音-/);
      const kept = service.keepRecovered(
        "session-keep-123456789",
        "keep-recovery-123456",
      );
      const repeated = service.keepRecovered(
        "session-keep-123456789",
        "keep-recovery-123456",
      );
      expect(repeated).toEqual(kept);
      expect(kept).toEqual(
        expect.objectContaining({
          state: "partial_capture",
          recordingSha256: "c".repeat(64),
        }),
      );
      expect(service.listRecoveries()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("selects the next recovery after disposing the current one", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    const firstSessionId = "session-recovery-a-123456";
    const secondSessionId = "session-recovery-b-123456";
    native.recover.mockResolvedValueOnce([
      snapshot({ sessionId: firstSessionId, state: "recoverable" }),
      snapshot({ sessionId: secondSessionId, state: "recoverable" }),
    ]);
    const service = new DesktopCaptureService(
      new CaptureRepository(database),
      native,
      "/tmp/voice2text-capture-test-root",
      () => 3_500,
    );
    try {
      await service.recover();
      await service.discardRecovered(firstSessionId, "discard-first-recovery");

      expect(service.snapshot()?.sessionId).toBe(secondSessionId);
      expect(
        service.renameSession(secondSessionId, "第二段恢复录制").title,
      ).toBe("第二段恢复录制");
    } finally {
      database.close();
    }
  });

  it("durably reconciles an all-track native start failure", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.start.mockRejectedValueOnce(new Error("both tracks failed"));
    native.snapshot.mockRejectedValueOnce(new Error("no native session"));
    const repository = new CaptureRepository(database);
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 4_000,
    );
    try {
      const failed = await service.start({
        sessionId: "session-start-failed-123456",
        title: "无法启动",
        idempotencyKey: "start-failed-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(failed).toEqual(
        expect.objectContaining({
          state: "failed",
          interruptionReason: "native_start_failed",
        }),
      );
      expect(
        repository.receipt(failed.sessionId, "start-failed-123456"),
      ).toEqual(expect.objectContaining({ action: "start" }));
    } finally {
      database.close();
    }
  });

  it("reconciles a start response loss without hiding a live native capture", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.start.mockRejectedValueOnce(new Error("response lost"));
    native.snapshot.mockResolvedValueOnce(
      runtimeSnapshot({ sessionId: "session-start-lost-123456" }),
    );
    const repository = new CaptureRepository(database);
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 4_500,
    );
    try {
      const recovered = await service.start({
        sessionId: "session-start-lost-123456",
        title: "启动响应丢失",
        idempotencyKey: "start-lost-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });
      expect(recovered.state).toBe("recording");
      expect(
        repository.receipt(recovered.sessionId, "start-lost-123456"),
      ).toEqual(expect.objectContaining({ action: "start" }));
    } finally {
      database.close();
    }
  });

  it("commits a completed native journal that crashed before the Main stop receipt", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.recover.mockResolvedValue([
      snapshot({
        sessionId: "session-completed-crash-123456",
        state: "completed",
        systemAudioHealthy: false,
        microphoneHealthy: false,
        finalizedChunkCount: 1,
        recordingSha256: "d".repeat(64),
        journalSha256: "d".repeat(64),
      }),
    ]);
    const repository = new CaptureRepository(database);
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 5_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      await service.recover();
      await service.recover();
      expect(repository.find("session-completed-crash-123456")?.state).toBe(
        "completed",
      );
      expect(
        database
          .prepare(
            "SELECT COUNT(*) count FROM capture_command_receipts WHERE action = 'stop'",
          )
          .get()?.count,
      ).toBe(1);
      expect(service.listRecoveries()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reconciles a rejected stop against the live session before allowing retry", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("command"));
    native.snapshot.mockResolvedValueOnce(
      runtimeSnapshot({ sessionId: "session-stop-rejected-123456" }),
    );
    repository.beginSession({
      sessionId: "session-stop-rejected-123456",
      title: "Stop rejected",
      workspacePath:
        "/tmp/voice2text-capture-test-root/session-stop-rejected-123456",
      nowMs: 1,
    });
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 6_000,
    );
    try {
      await expect(
        service.stopAndReconcile({
          action: "stop",
          sessionId: "session-stop-rejected-123456",
          idempotencyKey: "stop-rejected-123456",
        }),
      ).resolves.toMatchObject({
        capability: "live-stoppable",
        snapshot: { state: "recording" },
      });
      expect(
        repository.hasActionReceipt("session-stop-rejected-123456", "stop"),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("persists one stop receipt when a rejected stop reconciles terminal authority", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("command"));
    native.snapshot.mockResolvedValueOnce(
      runtimeSnapshot({
        sessionId: "session-stop-terminal-123456",
        state: "completed",
        systemAudioHealthy: false,
        microphoneHealthy: false,
        finalizedChunkCount: 1,
        recordingSha256: "d".repeat(64),
        journalSha256: "d".repeat(64),
      }),
    );
    repository.beginSession({
      sessionId: "session-stop-terminal-123456",
      title: "Terminal stop",
      workspacePath:
        "/tmp/voice2text-capture-test-root/session-stop-terminal-123456",
      nowMs: 1,
    });
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 6_500,
      async (options) => authorityFixture(options.sessionId),
    );
    const command = {
      action: "stop" as const,
      sessionId: "session-stop-terminal-123456",
      idempotencyKey: "stop-terminal-123456",
    };
    try {
      const first = await service.stopAndReconcile(command);
      const repeated = await service.stopAndReconcile(command);
      expect(first).toMatchObject({
        capability: "recovered-terminal",
        snapshot: { state: "completed" },
      });
      expect(repeated.snapshot).toEqual(first.snapshot);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) count FROM capture_command_receipts WHERE action = 'stop'",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("recreates after transport loss and persists recoverable truth without a stop receipt", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    const sessionId = "session-stop-transport-123456";
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("transport"));
    native.recreateAfterTransportLoss.mockResolvedValueOnce(undefined);
    native.recover.mockResolvedValueOnce([
      snapshot({
        sessionId,
        state: "recoverable",
        systemAudioHealthy: false,
        microphoneHealthy: false,
        partialCapture: true,
        finalizedChunkCount: 1,
        journalSha256: "c".repeat(64),
      }),
    ]);
    repository.beginSession({
      sessionId,
      title: "Transport loss",
      workspacePath: `/tmp/voice2text-capture-test-root/${sessionId}`,
      nowMs: 1,
    });
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 7_000,
      async (options) => authorityFixture(options.sessionId),
    );
    try {
      await expect(
        service.stopAndReconcile({
          action: "stop",
          sessionId,
          idempotencyKey: "stop-transport-123456",
        }),
      ).resolves.toMatchObject({
        capability: "recovered-terminal",
        snapshot: { state: "recoverable", recordingSha256: null },
      });
      expect(native.recreateAfterTransportLoss).toHaveBeenCalledOnce();
      expect(repository.find(sessionId)?.state).toBe("recoverable");
      expect(repository.hasActionReceipt(sessionId, "stop")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("preserves a zero-chunk failed stop across exit and makes it discoverable after restart", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "voice2text-quit-recovery-"),
    );
    const databasePath = join(temporaryRoot, "audio.sqlite3");
    const sessionId = "session-preserved-exit-123456";
    const native = nativeFixture();
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("transport"));
    native.recover.mockResolvedValueOnce([
      snapshot({
        sessionId,
        state: "recoverable",
        systemAudioHealthy: false,
        microphoneHealthy: false,
        finalizedChunkCount: 0,
        recordingSha256: null,
        journalSha256: "e".repeat(64),
      }),
    ]);
    let database = openAudioDatabase(databasePath);
    try {
      const service = new DesktopCaptureService(
        new CaptureRepository(database),
        native,
        temporaryRoot,
        () => 8_000,
      );
      await service.start({
        sessionId,
        title: "Preserved recovery",
        idempotencyKey: "start-preserved-exit-123456",
        minimumFreeBytes: 1,
        captionEnabled: false,
      });

      const decisions: QuitDecision[] = ["stop-and-exit", "preserve-and-exit"];
      const exit = vi.fn();
      const teardown = vi.fn(async () => undefined);
      const ports = {
        currentCapture: () => service.snapshot(),
        activate: vi.fn(),
        dialogParent: () => undefined,
        showDecision: vi.fn(async () => decisions.shift()!),
        stopAndReconcile: async (options) =>
          await service.stopAndReconcile({ action: "stop", ...options }),
        publishCapture: vi.fn(),
        showSafeReturn: vi.fn(),
        suppressCapturePublications: vi.fn(),
        abortCapture: () => service.abortNativeSession(),
        teardown,
        quit: vi.fn(),
        exit,
      } satisfies CaptureQuitCoordinatorPorts;
      const coordinator = new CaptureQuitCoordinator(ports);

      await expect(coordinator.requestInteractive()).resolves.toBe(
        "recoverable-exit",
      );
      expect(native.abort).toHaveBeenCalledOnce();
      expect(teardown).toHaveBeenCalledWith("recovery-exit");
      expect(exit).toHaveBeenCalledOnce();
      expect(
        database
          .prepare(
            "SELECT COUNT(*) count FROM capture_command_receipts WHERE session_id = ? AND action = 'stop'",
          )
          .get(sessionId)?.count,
      ).toBe(0);
      expect(new CaptureRepository(database).find(sessionId)).toMatchObject({
        state: "recoverable",
        finalizedChunkCount: 0,
        recordingSha256: null,
      });

      database.close();
      database = openAudioDatabase(databasePath);
      const restartedNative = nativeFixture();
      restartedNative.recover.mockResolvedValueOnce([
        snapshot({
          sessionId,
          state: "recoverable",
          systemAudioHealthy: false,
          microphoneHealthy: false,
          finalizedChunkCount: 0,
          recordingSha256: null,
          journalSha256: "e".repeat(64),
        }),
      ]);
      const restarted = new DesktopCaptureService(
        new CaptureRepository(database),
        restartedNative,
        temporaryRoot,
        () => 9_000,
      );
      await expect(restarted.recover()).resolves.toHaveLength(1);
      expect(restarted.listRecoveries()).toEqual([
        expect.objectContaining({ sessionId, state: "recoverable" }),
      ]);
      expect(restarted.snapshot()).toMatchObject({
        sessionId,
        state: "recoverable",
        finalizedChunkCount: 0,
        recordingSha256: null,
      });
    } finally {
      database.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("commits a recreated terminal snapshot exactly once after stop response loss", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    const sessionId = "session-stop-response-lost-123456";
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("transport"));
    native.recover.mockResolvedValueOnce([
      snapshot({
        sessionId,
        state: "completed",
        systemAudioHealthy: false,
        microphoneHealthy: false,
        finalizedChunkCount: 1,
        recordingSha256: "d".repeat(64),
        journalSha256: "d".repeat(64),
      }),
    ]);
    repository.beginSession({
      sessionId,
      title: "Response lost",
      workspacePath: `/tmp/voice2text-capture-test-root/${sessionId}`,
      nowMs: 1,
    });
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
      () => 7_500,
      async (options) => authorityFixture(options.sessionId),
    );
    const command = {
      action: "stop" as const,
      sessionId,
      idempotencyKey: "stop-response-lost-123456",
    };
    try {
      const first = await service.stopAndReconcile(command);
      const repeated = await service.stopAndReconcile(command);

      expect(first).toMatchObject({
        capability: "recovered-terminal",
        snapshot: { state: "completed" },
      });
      expect(repeated.snapshot).toEqual(first.snapshot);
      expect(native.recreateAfterTransportLoss).toHaveBeenCalledOnce();
      expect(
        database
          .prepare(
            "SELECT COUNT(*) count FROM capture_command_receipts WHERE action = 'stop'",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("reports bounded unknown authority when transport recreation fails", async () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const native = nativeFixture();
    const sessionId = "session-stop-unknown-123456";
    native.stop.mockRejectedValueOnce(new CaptureNativeStopError("transport"));
    native.recreateAfterTransportLoss.mockRejectedValueOnce(
      new Error("replacement unavailable"),
    );
    repository.beginSession({
      sessionId,
      title: "Unknown stop",
      workspacePath: `/tmp/voice2text-capture-test-root/${sessionId}`,
      nowMs: 1,
    });
    const service = new DesktopCaptureService(
      repository,
      native,
      "/tmp/voice2text-capture-test-root",
    );
    try {
      await expect(
        service.stopAndReconcile({
          action: "stop",
          sessionId,
          idempotencyKey: "stop-unknown-123456",
        }),
      ).resolves.toEqual({
        capability: "unknown",
        snapshot: null,
      });
    } finally {
      database.close();
    }
  });
});

function nativeFixture() {
  return {
    preflight: vi.fn(async () => ({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "14.2",
      captureMode: "dual_track" as const,
      systemAudioPermission: "not_determined" as const,
      microphonePermission: "granted" as const,
      microphones: [{ id: "default", name: "Mac microphone", isDefault: true }],
      availableBytes: 1024 * 1024 * 1024,
      requiredBytes: 128 * 1024 * 1024,
      captionModelAvailable: false,
      canStart: true,
      blockingReasons: ["caption_model_unavailable"],
    })),
    start: vi.fn(async (command) =>
      runtimeSnapshot({ sessionId: command.sessionId }),
    ),
    pause: vi.fn(async () => runtimeSnapshot({ state: "paused" })),
    resume: vi.fn(async () => runtimeSnapshot()),
    stop: vi.fn(async () =>
      runtimeSnapshot({
        state: "completed",
        finalizedChunkCount: 2,
        recordingSha256: "a".repeat(64),
        journalSha256: "b".repeat(64),
      }),
    ),
    systemSleep: vi.fn(async (command) =>
      runtimeSnapshot({
        sessionId: command.sessionId,
        state: "paused",
        interruptionReason: "system_sleep",
      }),
    ),
    systemWake: vi.fn(async (command) =>
      runtimeSnapshot({
        sessionId: command.sessionId,
        state: "paused",
        interruptionReason: "system_wake_requires_resume",
      }),
    ),
    snapshot: vi.fn(async () => runtimeSnapshot()),
    recover: vi.fn(async (): Promise<CaptureSnapshot[]> => []),
    discard: vi.fn(async () => undefined),
    startMicrophoneTest: vi.fn(async (testId: string) =>
      microphoneTestSnapshot(testId, "running"),
    ),
    microphoneTestSnapshot: vi.fn(async (testId: string) =>
      microphoneTestSnapshot(testId, "running"),
    ),
    finishMicrophoneTest: vi.fn(async (testId: string) =>
      microphoneTestSnapshot(testId, "finished"),
    ),
    cancelMicrophoneTest: vi.fn(async (testId: string) =>
      microphoneTestSnapshot(testId, "cancelled"),
    ),
    recreateAfterTransportLoss: vi.fn(async () => undefined),
    abort: vi.fn(),
  } satisfies CaptureNativePort;
}

function microphoneTestSnapshot(
  testId: string,
  state: "running" | "finished" | "cancelled",
): MicrophoneTestSnapshot {
  return {
    testId,
    state,
    ...(state === "finished" ? { reason: "no-audio-frames" as const } : {}),
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
}

function snapshot(overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return captureSnapshotSchema.parse({
    sessionId: "session-capture-123456",
    state: "recording" as const,
    captureMode: "dual_track" as const,
    captureTimelineMs: 1_000,
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

function runtimeSnapshot(
  overrides: Partial<CaptureRuntimeSnapshot> = {},
): CaptureRuntimeSnapshot {
  const { audioActivity = 0, ...durableOverrides } = overrides;
  return captureRuntimeSnapshotSchema.parse({
    ...snapshot(durableOverrides),
    audioActivity,
  });
}

function authorityFixture(sessionId: string) {
  return {
    schema: "desktop-capture-session/v1" as const,
    sessionId,
    captureMode: "microphone_only" as const,
    tracks: [
      {
        kind: "microphone" as const,
        healthy: true,
        sampleRate: 48_000,
        channels: 1,
        format: "float32",
      },
    ],
    chunks: [],
    events: [],
  };
}
