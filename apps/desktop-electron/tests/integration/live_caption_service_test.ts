import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LiveCaptionService,
  type LiveCaptionWorkerLauncher,
} from "../../src/main/domain/captions/live_caption_service";
import { openElectronDatabase } from "../../src/main/storage/database";
import { TranscriptRepository } from "../../src/main/storage/repositories/transcript_repository";

const sessionId = "session-caption-service-123456";
const identity = {
  sessionId,
  sessionRoot: `/tmp/${sessionId}`,
  modelSha256: "a".repeat(64),
  resourceIdentity: "b".repeat(64),
  runtimeSha256: "c".repeat(64),
  protocolIdentity: "sensevoice-live-caption-worker/v1",
};

describe("live caption service", () => {
  const database = openElectronDatabase(":memory:");

  beforeEach(() => {
    database.exec("DELETE FROM capture_sessions");
    database
      .prepare(
        `INSERT INTO capture_sessions (
          session_id, title, workspace_path, state, capture_mode,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'Caption service', ?, 'recording', 'dual_track', 1000, 1000)`,
      )
      .run(sessionId, identity.sessionRoot);
  });

  it("persists completed utterances, progress, and a bounded flush", async () => {
    let onUtterance:
      | Parameters<LiveCaptionWorkerLauncher["launch"]>[0]["onUtterance"]
      | undefined;
    const worker = {
      poll: vi.fn(async () => ({ offsetBytes: 3_200, backlogBytes: 0 })),
      flush: vi.fn(async () => ({ offsetBytes: 3_200, backlogBytes: 0 })),
      close: vi.fn(async () => undefined),
    };
    const repository = new TranscriptRepository(database);
    const emitted: string[] = [];
    const service = new LiveCaptionService(
      repository,
      {
        launch: vi.fn(async (options) => {
          onUtterance = options.onUtterance;
          return worker;
        }),
      },
      (snapshot) => emitted.push(snapshot.draft!.state),
      () => 2_000,
    );

    const started = await service.start(identity);
    await onUtterance?.({
      type: "utterance",
      sessionId,
      generationId: started.draft!.generationId,
      attempt: started.draft!.attempt,
      sequence: 1,
      startMs: 0,
      endMs: 50,
      text: "完整话语",
      language: "zh",
      offsetBytes: 3_200,
      modelSha256: identity.modelSha256,
    });
    await service.poll(sessionId);
    const flushed = await service.flush(sessionId);

    expect(flushed).toEqual(
      expect.objectContaining({
        draft: expect.objectContaining({
          state: "flushed",
          utterances: [expect.objectContaining({ text: "完整话语" })],
        }),
      }),
    );
    expect(worker.close).toHaveBeenCalledOnce();
    expect(emitted).toContain("running");
    expect(emitted.at(-1)).toBe("flushed");
  });

  it("degrades a crashed caption worker without throwing into capture control", async () => {
    const worker = {
      poll: vi.fn(async () => {
        throw new Error("worker crashed");
      }),
      flush: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      { launch: vi.fn(async () => worker) },
      vi.fn(),
      () => 2_000,
    );

    await service.start(identity);
    await expect(service.poll(sessionId)).resolves.toEqual(
      expect.objectContaining({
        draft: expect.objectContaining({
          state: "degraded",
          errorCode: "CAPTION_WORKER_FAILED",
        }),
      }),
    );
    expect(worker.close).toHaveBeenCalledOnce();
    expect(
      database
        .prepare("SELECT state FROM capture_sessions WHERE session_id = ?")
        .get(sessionId)?.state,
    ).toBe("recording");
  });

  it("advances a blank worker sequence without publishing an empty utterance", async () => {
    let onSilence:
      | Parameters<LiveCaptionWorkerLauncher["launch"]>[0]["onSilence"]
      | undefined;
    const worker = {
      poll: vi.fn(async () => ({ offsetBytes: 3_200, backlogBytes: 0 })),
      flush: vi.fn(async () => ({ offsetBytes: 3_200, backlogBytes: 0 })),
      close: vi.fn(async () => undefined),
    };
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      {
        launch: vi.fn(async (options) => {
          onSilence = options.onSilence;
          return worker;
        }),
      },
      vi.fn(),
      () => 2_000,
    );
    const started = await service.start(identity);

    await onSilence?.({
      type: "silence",
      sessionId,
      generationId: started.draft!.generationId,
      attempt: started.draft!.attempt,
      sequence: 1,
      startMs: 0,
      endMs: 100,
      offsetBytes: 3_200,
      modelSha256: identity.modelSha256,
    });
    const flushed = await service.flush(sessionId);

    expect(flushed?.draft).toEqual(
      expect.objectContaining({ state: "flushed", utterances: [] }),
    );
    expect(
      repository.createOrResumeDraft({ ...identity, nowMs: 2_100 }),
    ).toEqual(
      expect.objectContaining({ offsetBytes: 3_200, firstSequence: 2 }),
    );
  });

  it("degrades and closes the worker when backlog exceeds 960000 bytes", async () => {
    const worker = {
      poll: vi.fn(async () => ({
        offsetBytes: 0,
        backlogBytes: 960_001,
      })),
      flush: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      { launch: vi.fn(async () => worker) },
      vi.fn(),
      () => 2_000,
    );

    await service.start(identity);
    const snapshot = await service.poll(sessionId);

    expect(snapshot?.draft).toEqual(
      expect.objectContaining({
        state: "degraded",
        errorCode: "CAPTION_BACKLOG_EXCEEDED",
        backlogBytes: 960_000,
      }),
    );
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it("marks an in-flight draft interrupted on startup and resumes with a new attempt", async () => {
    const repository = new TranscriptRepository(database);
    const first = repository.createOrResumeDraft({ ...identity, nowMs: 1_000 });
    repository.markDraftState({
      sessionId,
      generationId: first.generationId,
      attempt: first.attempt,
      state: "running",
      errorCode: null,
      nowMs: 1_100,
    });
    const launcher = { launch: vi.fn(async () => workerStub()) };
    const service = new LiveCaptionService(
      repository,
      launcher,
      vi.fn(),
      () => 2_000,
    );

    expect(service.reconcileStartup()).toBe(1);
    const resumed = await service.start(identity);
    expect(resumed.draft!.generationId).toBe(first.generationId);
    expect(resumed.draft!.attempt).toBe(first.attempt + 1);
    await service.shutdown();
  });

  it("serializes concurrent starts and owns exactly one session worker", async () => {
    const worker = workerStub();
    const launch = vi.fn(async () => worker);
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      { launch },
      vi.fn(),
      () => 2_000,
    );

    const [first, duplicate] = await Promise.all([
      service.start(identity),
      service.start(identity),
    ]);

    expect(launch).toHaveBeenCalledOnce();
    expect(duplicate.draft?.generationId).toBe(first.draft?.generationId);
    await expect(
      service.start({
        ...identity,
        sessionId: "session-caption-other-123456",
        sessionRoot: "/tmp/session-caption-other-123456",
      }),
    ).rejects.toThrow(/different live-caption session/i);
    expect(launch).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("serializes pause after an in-flight poll so stale progress cannot restore running", async () => {
    let resolvePoll!: (value: {
      offsetBytes: number;
      backlogBytes: number;
    }) => void;
    const worker = workerStub();
    worker.flush.mockResolvedValueOnce({ offsetBytes: 3_200, backlogBytes: 0 });
    worker.poll.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      { launch: vi.fn(async () => worker) },
      vi.fn(),
      () => 2_000,
    );
    await service.start(identity);

    const polling = service.poll(sessionId);
    const pausing = service.pause(sessionId);
    await Promise.resolve();
    resolvePoll({ offsetBytes: 3_200, backlogBytes: 0 });
    await polling;
    const paused = await pausing;

    expect(paused?.draft?.state).toBe("paused");
    expect(repository.getSnapshot(sessionId)?.draft?.state).toBe("paused");
    await service.shutdown();
  });

  it("waits for an in-flight poll before flushing the worker", async () => {
    let resolvePoll!: (value: {
      offsetBytes: number;
      backlogBytes: number;
    }) => void;
    const worker = workerStub();
    worker.flush.mockResolvedValueOnce({ offsetBytes: 3_200, backlogBytes: 0 });
    worker.poll.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const repository = new TranscriptRepository(database);
    const service = new LiveCaptionService(
      repository,
      { launch: vi.fn(async () => worker) },
      vi.fn(),
      () => 2_000,
    );
    await service.start(identity);

    const polling = service.poll(sessionId);
    const flushing = service.flush(sessionId);
    await Promise.resolve();
    expect(worker.flush).not.toHaveBeenCalled();
    resolvePoll({ offsetBytes: 3_200, backlogBytes: 0 });
    await polling;
    const flushed = await flushing;

    expect(worker.flush).toHaveBeenCalledOnce();
    expect(flushed?.draft?.state).toBe("flushed");
    expect(worker.close).toHaveBeenCalledOnce();
  });
});

function workerStub() {
  return {
    poll: vi.fn(async () => ({ offsetBytes: 0, backlogBytes: 0 })),
    flush: vi.fn(async () => ({ offsetBytes: 0, backlogBytes: 0 })),
    close: vi.fn(async () => undefined),
  };
}
