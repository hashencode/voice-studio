import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DesktopCaptureService } from "../../src/main/domain/capture/desktop_capture_service";
import type { CaptureNativePort } from "../../src/main/domain/capture/capture_native_port";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { CaptureRepository } from "../../src/main/storage/repositories/capture_repository";
import {
  captureSnapshotSchema,
  desktopCaptureParitySchema,
  type CaptureSnapshot,
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
      const stopped = await service.control({
        action: "stop",
        sessionId: started.sessionId,
        idempotencyKey: "stop-capture-123456",
      });
      const repeated = await service.control({
        action: "stop",
        sessionId: started.sessionId,
        idempotencyKey: "stop-capture-123456",
      });
      expect(stopped.state).toBe("completed");
      expect(repeated).toEqual(stopped);
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

  it("preserves one healthy track, visible gaps, and recoverable authority", async () => {
    const database = openAudioDatabase(":memory:");
    const native = nativeFixture();
    native.start.mockResolvedValueOnce(
      snapshot({
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
      snapshot({ sessionId: "session-start-lost-123456" }),
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
    start: vi.fn(async (command) => snapshot({ sessionId: command.sessionId })),
    pause: vi.fn(async () => snapshot({ state: "paused" })),
    resume: vi.fn(async () => snapshot()),
    stop: vi.fn(async () =>
      snapshot({
        state: "completed",
        finalizedChunkCount: 2,
        recordingSha256: "a".repeat(64),
        journalSha256: "b".repeat(64),
      }),
    ),
    systemSleep: vi.fn(async (command) =>
      snapshot({
        sessionId: command.sessionId,
        state: "paused",
        interruptionReason: "system_sleep",
      }),
    ),
    systemWake: vi.fn(async (command) =>
      snapshot({
        sessionId: command.sessionId,
        state: "paused",
        interruptionReason: "system_wake_requires_resume",
      }),
    ),
    snapshot: vi.fn(async () => snapshot()),
    recover: vi.fn(async (): Promise<CaptureSnapshot[]> => []),
    discard: vi.fn(async () => undefined),
  } satisfies CaptureNativePort;
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
