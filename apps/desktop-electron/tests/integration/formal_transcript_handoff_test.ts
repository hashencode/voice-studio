import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormalTranscriptHandoffService } from "../../src/main/domain/captions/formal_transcript_handoff_service";
import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { openElectronDatabase } from "../../src/main/storage/database";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";
import { TranscriptRepository } from "../../src/main/storage/repositories/transcript_repository";
import { profilePathsForRoot } from "../../src/main/profile/profile_paths";

const sessionId = "session-formal-handoff-123456";
const roots: string[] = [];

describe("capture to formal transcript handoff", () => {
  const database = openElectronDatabase(":memory:");
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    database.exec("DROP TRIGGER IF EXISTS fail_formal_enqueue");
    database.exec("DELETE FROM capture_sessions");
    database.exec("DELETE FROM meetings");
    database.exec("DELETE FROM media_authorities");
    fixture = await createFixture(database);
  });

  afterEach(async () => {
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  it("enqueues exactly one formal job after durable capture even when draft flush fails", async () => {
    const flushDraft = vi.fn(async () => {
      throw new Error("caption worker crashed during flush");
    });
    const prepareMedia = vi.fn(async () => fixture.media);
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft,
      prepareMedia,
      scheduleProcessing: fixture.schedule,
    });

    const first = await service.finalize(fixture.command);
    const replay = await service.finalize(fixture.command);

    expect(first.formal.state).toBe("queued");
    expect(replay.formal.attempt).toBe(first.formal.attempt);
    expect(flushDraft).toHaveBeenCalledTimes(2);
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(fixture.schedule).toHaveBeenCalledOnce();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()
        ?.count,
    ).toBe(1);
    expect(
      database
        .prepare("SELECT state, recording_sha256 FROM capture_sessions")
        .get(),
    ).toEqual(
      expect.objectContaining({
        state: "completed",
        recording_sha256: "d".repeat(64),
      }),
    );
  });

  it("records enqueue failure without touching capture and retries by expected-attempt CAS", async () => {
    database.exec(`
      CREATE TEMP TRIGGER fail_formal_enqueue
      BEFORE INSERT ON processing_jobs BEGIN
        SELECT RAISE(ABORT, 'injected enqueue failure');
      END;
    `);
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });

    const failed = await service.finalize(fixture.command);
    expect(failed.formal).toEqual(
      expect.objectContaining({ attempt: 1, state: "failed" }),
    );
    database.exec("DROP TRIGGER fail_formal_enqueue");
    const retried = await service.retry({
      sessionId,
      expectedAttempt: 1,
      idempotencyKey: "retry-formal-handoff-123456",
    });
    expect(retried.formal).toEqual(
      expect.objectContaining({ attempt: 2, state: "queued" }),
    );
    await expect(
      service.retry({
        sessionId,
        expectedAttempt: 1,
        idempotencyKey: "retry-formal-late-123456",
      }),
    ).rejects.toThrow(/attempt/i);
    expect(
      database.prepare("SELECT state FROM capture_sessions").get()?.state,
    ).toBe("completed");
  });

  it("keeps partial output inactive and exposes only the completed formal generation", async () => {
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });
    const queued = await service.finalize(fixture.command);
    expect(queued.formal.generationId).toBeNull();
    const domain = new DesktopDomainService(fixture.desktop, () => 5_000);
    const intent = domain.claimNextProcessingJob({
      sourceIdentity: "formal-worker-source",
      deadlineAtMs: 50_000,
    })!;
    expect(
      fixture.transcripts.syncFormalForProcessingJob(intent.jobId, 5_001)
        ?.formal.state,
    ).toBe("running");
    expect(() =>
      domain.publishProcessingResult({
        ...intent,
        complete: false,
        payload: {},
      }),
    ).toThrow(/partial/i);
    expect(
      fixture.transcripts.getSnapshot(sessionId)?.formal.generationId,
    ).toBeNull();
    const diar = domain.advanceProcessingPhase(intent, {
      operationId: "diarization",
      phase: "diarization",
      ...fixture.pipeline,
    });
    domain.publishProcessingResult({
      ...diar,
      complete: true,
      payload: {
        text: "正式文本",
        segments: [
          {
            startSeconds: 0,
            endSeconds: 1,
            text: "正式文本",
            speakerAssignment: "unknown",
            anonymousSpeakerKey: null,
          },
        ],
        diarizationSucceeded: false,
      },
    });
    expect(
      fixture.transcripts.syncFormalForProcessingJob(intent.jobId, 5_002)
        ?.formal.state,
    ).toBe("completed");
    const completed = fixture.transcripts.getSnapshot(sessionId)!;
    const activeGenerationId = Number(
      database.prepare("SELECT active_generation_id FROM meetings").get()
        ?.active_generation_id,
    );
    expect(completed.formal).toEqual(
      expect.objectContaining({
        generationId: activeGenerationId,
        state: "completed",
      }),
    );
    const unrelated = domain.enqueueProcessingJob({
      meetingId: Number(
        database
          .prepare(
            "SELECT meeting_id FROM caption_formal_handoffs WHERE session_id = ?",
          )
          .get(sessionId)?.meeting_id,
      ),
      idempotencyKey: "later-same-media-job-123456",
      operationId: "asr",
      phase: "asr",
      ...fixture.pipeline,
      sourceSha256: fixture.media.normalizedSha256,
    });
    const laterIntent = domain.claimNextProcessingJob({
      sourceIdentity: "later-worker-source",
      deadlineAtMs: 60_000,
    })!;
    expect(laterIntent.jobId).toBe(unrelated.value.id);
    const laterDiar = domain.advanceProcessingPhase(laterIntent, {
      operationId: "diarization",
      phase: "diarization",
      ...fixture.pipeline,
    });
    domain.publishProcessingResult({
      ...laterDiar,
      complete: true,
      payload: {
        text: "后续正式文本",
        segments: [
          {
            startSeconds: 0,
            endSeconds: 1,
            text: "后续正式文本",
            speakerAssignment: "unknown",
            anonymousSpeakerKey: null,
          },
        ],
        diarizationSucceeded: false,
      },
    });
    expect(
      Number(
        database.prepare("SELECT active_generation_id FROM meetings").get()
          ?.active_generation_id,
      ),
    ).not.toBe(activeGenerationId);
    expect(
      fixture.transcripts.getSnapshot(sessionId)?.formal.generationId,
    ).toBe(activeGenerationId);
  });

  it("never adopts an unrelated existing meeting job for the same media", async () => {
    const media = database
      .prepare(
        `INSERT INTO media_authorities (
          content_sha256, normalized_path, source_sha256, size_bytes,
          duration_ms, receipt_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fixture.media.normalizedSha256,
        fixture.media.normalizedPath,
        fixture.media.sourceSha256,
        fixture.media.normalizedSizeBytes,
        fixture.media.durationMs,
        JSON.stringify(fixture.media.receipt),
        900,
      );
    const meeting = database
      .prepare(
        `INSERT INTO meetings (
          idempotency_key, source_identity, display_name, media_path,
          duration_ms, media_authority_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "unrelated-meeting",
        "unrelated-source",
        "Unrelated import",
        fixture.media.normalizedPath,
        fixture.media.durationMs,
        Number(media.lastInsertRowid),
        900,
        900,
      );
    const unrelated = fixture.desktop.enqueueProcessingJob(
      {
        meetingId: Number(meeting.lastInsertRowid),
        idempotencyKey: "unrelated-job",
        operationId: "asr",
        resourceIdentity: "9".repeat(64),
        protocolIdentity: "unrelated/v1",
        sourceSha256: fixture.media.normalizedSha256,
        modelSha256: "8".repeat(64),
        runtimeSha256: "7".repeat(64),
      },
      900,
    ).value;
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });

    const result = await service.finalize(fixture.command);
    const formalJobId = Number(
      database
        .prepare(
          "SELECT processing_job_id FROM caption_formal_handoffs WHERE session_id = ?",
        )
        .get(sessionId)?.processing_job_id,
    );

    expect(result.formal.state).toBe("queued");
    expect(formalJobId).not.toBe(unrelated.id);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()
        ?.count,
    ).toBe(2);
  });

  it("persists media preparation failure and retries preparation with a fenced new attempt", async () => {
    const prepareMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("injected media validation failure"))
      .mockResolvedValueOnce(fixture.media);
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia,
      scheduleProcessing: fixture.schedule,
    });

    const failed = await service.finalize(fixture.command);
    expect(failed.formal).toEqual(
      expect.objectContaining({
        attempt: 1,
        state: "failed",
        errorCode: "FORMAL_MEDIA_PREPARATION_FAILED",
      }),
    );

    const retried = await service.retry({
      sessionId,
      expectedAttempt: 1,
      idempotencyKey: "retry-formal-preparation-123456",
    });
    expect(retried.formal).toEqual(
      expect.objectContaining({ attempt: 2, state: "queued" }),
    );
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(fixture.schedule).toHaveBeenCalledOnce();
  });

  it("replays a failed preparation retry by idempotency key", async () => {
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => {
        throw new Error("injected preparation failure");
      }),
      scheduleProcessing: fixture.schedule,
    });
    const first = await service.finalize(fixture.command);
    const retryCommand = {
      sessionId,
      expectedAttempt: first.formal.attempt,
      idempotencyKey: "retry-preparation-failure-123456",
    };

    const failedRetry = await service.retry(retryCommand);
    const replay = await service.retry(retryCommand);

    expect(failedRetry.formal).toEqual(
      expect.objectContaining({ attempt: 2, state: "failed" }),
    );
    expect(replay).toEqual(failedRetry);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM caption_command_receipts WHERE session_id = ?",
        )
        .get(sessionId)?.count,
    ).toBe(1);
  });

  it("queues formal processing without inventing a live draft when captions were disabled", async () => {
    database
      .prepare("DELETE FROM caption_sessions WHERE session_id = ?")
      .run(sessionId);
    const service = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => null),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });

    const queued = await service.finalize(fixture.command);

    expect(queued.draft).toBeNull();
    expect(queued.formal).toEqual(
      expect.objectContaining({ attempt: 1, state: "queued" }),
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM caption_sessions").get()
        ?.count,
    ).toBe(0);
  });

  it("clears stale preparation across a crash between handoff save and enqueue", async () => {
    fixture.transcripts.beginFormalPreparation({
      sessionId,
      displayName: fixture.command.displayName,
      operationId: "asr",
      ...fixture.pipeline,
      nowMs: 2_000,
    });
    fixture.transcripts.saveFormalHandoff({
      sessionId,
      displayName: fixture.command.displayName,
      ...fixture.media,
      ...fixture.pipeline,
      nowMs: 2_000,
    });
    const restarted = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });

    const [queued] = await restarted.reconcileStartup();
    expect(queued).toBeDefined();
    if (!queued) throw new Error("startup did not resume formal handoff");
    expect(queued.formal.state).toBe("queued");
    expect(fixture.transcripts.formalPreparation(sessionId)).toBeNull();
    expect(fixture.schedule).toHaveBeenCalledOnce();
    database
      .prepare(
        "UPDATE processing_jobs SET state = 'interrupted', error_code = 'PROCESS_INTERRUPTED' WHERE id = (SELECT processing_job_id FROM caption_formal_handoffs WHERE session_id = ?)",
      )
      .run(sessionId);
    expect(fixture.transcripts.reconcileFormalProcessingAttempts(2_100)).toBe(
      1,
    );
    await expect(
      restarted.retry({
        sessionId,
        expectedAttempt: 1,
        idempotencyKey: "retry-after-save-crash-123456",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        formal: expect.objectContaining({ attempt: 2, state: "queued" }),
      }),
    );
  });

  it("resumes a durable preparation after restart without an external finalize call", async () => {
    fixture.transcripts.beginFormalPreparation({
      sessionId,
      displayName: fixture.command.displayName,
      operationId: "asr",
      ...fixture.pipeline,
      nowMs: 2_000,
    });
    const prepareMedia = vi.fn(async () => fixture.media);
    const restarted = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia,
      scheduleProcessing: fixture.schedule,
    });

    const [queued] = await restarted.reconcileStartup();
    if (!queued) throw new Error("startup did not resume formal preparation");

    expect(queued).toEqual(
      expect.objectContaining({
        formal: expect.objectContaining({ attempt: 1, state: "queued" }),
      }),
    );
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(fixture.schedule).toHaveBeenCalledOnce();
    expect(fixture.transcripts.pendingFormalFinalizations()).toEqual([]);
  });

  it("drains more than one bounded startup batch without stranding intents", async () => {
    const count = 257;
    for (let index = 0; index < count; index += 1) {
      const batchedSessionId = `session-batch-${String(index).padStart(6, "0")}-123456`;
      database
        .prepare(
          `INSERT INTO capture_sessions (
            session_id, title, workspace_path, state, capture_mode,
            recording_sha256, created_at_ms, updated_at_ms
          ) VALUES (?, 'Batch formal', ?, 'completed', 'dual_track', ?, 1000, 1000)`,
        )
        .run(
          batchedSessionId,
          path.join(fixture.profile.captureDirectory, batchedSessionId),
          "d".repeat(64),
        );
      fixture.transcripts.beginFormalPreparation({
        sessionId: batchedSessionId,
        displayName: `Batch formal ${index}`,
        operationId: "asr",
        ...fixture.pipeline,
        nowMs: 2_000,
      });
    }
    const restarted = new FormalTranscriptHandoffService({
      repository: fixture.transcripts,
      profile: fixture.profile,
      flushDraft: vi.fn(async () => undefined),
      prepareMedia: vi.fn(async () => fixture.media),
      scheduleProcessing: fixture.schedule,
    });

    const recovered = await restarted.reconcileStartup();

    expect(recovered).toHaveLength(count);
    expect(fixture.schedule).toHaveBeenCalledTimes(count);
    expect(fixture.transcripts.pendingFormalFinalizations()).toEqual([]);
  });
});

async function createFixture(
  database: ReturnType<typeof openElectronDatabase>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "formal-handoff-"));
  roots.push(root);
  const profile = profilePathsForRoot(path.join(root, "profile"));
  await mkdir(profile.mediaDirectory, { recursive: true });
  const mediaPath = path.join(profile.mediaDirectory, "capture-formal.wav");
  const bytes = Buffer.concat([Buffer.alloc(44), Buffer.alloc(32_000)]);
  await writeFile(mediaPath, bytes);
  const mediaSha256 = createHash("sha256").update(bytes).digest("hex");
  database
    .prepare(
      `INSERT INTO capture_sessions (
        session_id, title, workspace_path, state, capture_mode,
        recording_sha256, created_at_ms, updated_at_ms
      ) VALUES (?, 'Formal handoff', ?, 'completed', 'dual_track', ?, 1000, 1000)`,
    )
    .run(
      sessionId,
      path.join(profile.captureDirectory, sessionId),
      "d".repeat(64),
    );
  const transcripts = new TranscriptRepository(database, profile);
  transcripts.createOrResumeDraft({
    sessionId,
    modelSha256: "a".repeat(64),
    resourceIdentity: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    protocolIdentity: "sensevoice-live-caption-worker/v1",
    nowMs: 1_100,
  });
  const pipeline = {
    resourceIdentity: "e".repeat(64),
    protocolIdentity: "desktop-sherpa-worker/v1",
    modelSha256: "f".repeat(64),
    runtimeSha256: "1".repeat(64),
  };
  return {
    transcripts,
    profile,
    desktop: new DesktopRepository(database, profile),
    pipeline,
    schedule: vi.fn(),
    media: {
      normalizedPath: mediaPath,
      normalizedSha256: mediaSha256,
      sourceSha256: "d".repeat(64),
      normalizedSizeBytes: bytes.length,
      durationMs: 1_000,
      receipt: { schemaVersion: 1, kind: "capture-formal" },
    },
    command: {
      sessionId,
      displayName: "Formal handoff",
      processing: { operationId: "asr" as const, ...pipeline },
    },
  };
}
