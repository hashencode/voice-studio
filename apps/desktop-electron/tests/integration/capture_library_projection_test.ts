import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptureLibraryProjectionService } from "../../src/main/domain/capture/capture_library_projection_service";
import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { profilePathsForRoot } from "../../src/main/profile/profile_paths";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";
import { CaptureRepository } from "../../src/main/storage/repositories/capture_repository";
import { captureSnapshotSchema } from "../../src/shared/contracts/capture";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("capture library projection", () => {
  it("inserts once and replays one session from its authoritative receipt", async () => {
    const fixture = await createFixture();
    const service = fixture.service();

    const first = await service.project({
      sessionId: fixture.firstSessionId,
      displayName: "First capture",
    });
    const replay = await service.project({
      sessionId: fixture.firstSessionId,
      displayName: "First capture",
    });

    expect(first).toEqual({
      sessionId: fixture.firstSessionId,
      audioId: first.audioId,
      inserted: true,
    });
    expect(replay).toEqual({ ...first, inserted: false });
    expect(fixture.count("audio_items")).toBe(1);
    expect(fixture.count("media_authorities")).toBe(1);
    expect(fixture.count("durable_receipts")).toBe(1);
  });

  it("deduplicates identical content while recording a receipt per session", async () => {
    const fixture = await createFixture();
    const service = fixture.service();

    const first = await service.project({
      sessionId: fixture.firstSessionId,
      displayName: "First capture",
    });
    const second = await service.project({
      sessionId: fixture.secondSessionId,
      displayName: "Second capture",
    });

    expect(second).toEqual({
      sessionId: fixture.secondSessionId,
      audioId: first.audioId,
      inserted: false,
    });
    expect(fixture.count("audio_items")).toBe(1);
    expect(fixture.count("media_authorities")).toBe(1);
    expect(
      fixture.database
        .prepare(
          "SELECT idempotency_key, audio_id FROM durable_receipts ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        idempotency_key: `capture-library:${fixture.firstSessionId}`,
        audio_id: first.audioId,
      },
      {
        idempotency_key: `capture-library:${fixture.secondSessionId}`,
        audio_id: first.audioId,
      },
    ]);
  });

  it("classifies invalid authority without changing the durable capture", async () => {
    const fixture = await createFixture();
    const service = fixture.service(async () => {
      throw new Error("journal authority rejected a changed spool");
    });

    await expect(
      service.project({
        sessionId: fixture.firstSessionId,
        displayName: "Invalid capture",
      }),
    ).rejects.toMatchObject({
      code: "invalid_authority",
      message: "Capture media authority could not be verified",
    });
    expect(fixture.captureState()).toBe("completed");
    expect(fixture.count("audio_items")).toBe(0);
    expect(fixture.count("durable_receipts")).toBe(0);
  });

  it("rolls back a failed commit and returns a safe failure classification", async () => {
    const fixture = await createFixture();
    fixture.database.exec(`
      CREATE TEMP TRIGGER fail_capture_library_commit
      BEFORE INSERT ON durable_receipts BEGIN
        SELECT RAISE(ABORT, 'sensitive injected sqlite failure');
      END;
    `);

    await expect(
      fixture.service().project({
        sessionId: fixture.firstSessionId,
        displayName: "Commit failure",
      }),
    ).rejects.toMatchObject({
      code: "commit_failed",
      message: "Capture media could not be added to the library",
    });
    expect(fixture.captureState()).toBe("completed");
    expect(fixture.count("audio_items")).toBe(0);
    expect(fixture.count("media_authorities")).toBe(0);
    expect(fixture.count("durable_receipts")).toBe(0);
  });

  it("reconciles authorized terminal captures and excludes unsettled partial captures", async () => {
    const fixture = await createFixture();
    fixture.authorizeStop(fixture.firstSessionId);
    fixture.keepPartial(fixture.secondSessionId);
    const unsettledSessionId = "session-library-unsettled-123456";
    fixture.addCapture(unsettledSessionId, {
      state: "partial_capture",
      updatedAtMs: 2_000,
    });
    const projected: string[] = [];

    const result = await fixture.service().reconcileStartup({
      repository: fixture.captureRepository,
      onProjected: (receipt) => projected.push(receipt.sessionId),
    });

    expect(result).toEqual({ attempted: 2, projected: 2, failed: 0 });
    expect(projected).toEqual([
      fixture.firstSessionId,
      fixture.secondSessionId,
    ]);
    expect(fixture.count("audio_items")).toBe(1);
    expect(fixture.count("durable_receipts")).toBe(2);
    expect(
      fixture.database
        .prepare("SELECT 1 FROM durable_receipts WHERE idempotency_key = ?")
        .get(`capture-library:${unsettledSessionId}`),
    ).toBeUndefined();
  });

  it("advances a stable cursor past more invalid candidates than one slice", async () => {
    const fixture = await createFixture();
    const sessionIds = Array.from(
      { length: 5 },
      (_, index) => `session-library-slice-${index}-123456`,
    );
    sessionIds.forEach((sessionId, index) => {
      fixture.addCapture(sessionId, { updatedAtMs: 10_000 + index });
      fixture.authorizeStop(sessionId);
    });
    const yieldControl = vi.fn(async () => undefined);
    const service = fixture.service(async (sessionId) => {
      if (sessionId !== sessionIds.at(-1)) {
        throw new Error("invalid historic spool");
      }
      return fixture.media;
    });

    await expect(
      service.reconcileStartup({
        repository: fixture.captureRepository,
        maxCandidatesPerSlice: 2,
        yieldControl,
      }),
    ).resolves.toEqual({ attempted: 5, projected: 1, failed: 4 });
    expect(yieldControl).toHaveBeenCalledTimes(2);
    expect(
      fixture.database
        .prepare("SELECT 1 FROM durable_receipts WHERE idempotency_key = ?")
        .get(`capture-library:${sessionIds.at(-1)}`),
    ).toBeDefined();
  });

  it("yields on elapsed budget, preserves captures, and repeated startup is a no-op", async () => {
    const fixture = await createFixture();
    fixture.authorizeStop(fixture.firstSessionId);
    fixture.authorizeStop(fixture.secondSessionId);
    const before = fixture.captureRows();
    let clock = 0;
    const yieldControl = vi.fn(async () => undefined);
    const service = fixture.service();

    const first = await service.reconcileStartup({
      repository: fixture.captureRepository,
      maxCandidatesPerSlice: 10,
      maxSliceMs: 5,
      now: () => (clock += 10),
      yieldControl,
    });
    const replay = await service.reconcileStartup({
      repository: fixture.captureRepository,
      yieldControl,
    });

    expect(first).toEqual({ attempted: 2, projected: 2, failed: 0 });
    expect(replay).toEqual({ attempted: 0, projected: 0, failed: 0 });
    expect(yieldControl).toHaveBeenCalled();
    expect(fixture.captureRows()).toEqual(before);
    expect(fixture.count("audio_items")).toBe(1);
    expect(fixture.count("durable_receipts")).toBe(2);
  });

  it("serializes a live projection with startup reconciliation for one session", async () => {
    const fixture = await createFixture();
    fixture.authorizeStop(fixture.firstSessionId);
    const prepared = deferred<typeof fixture.media>();
    const service = fixture.service(async () => await prepared.promise);

    const live = service.project({
      sessionId: fixture.firstSessionId,
      displayName: "Live capture",
    });
    const recovery = service.reconcileStartup({
      repository: fixture.captureRepository,
    });
    prepared.resolve(fixture.media);

    await expect(live).resolves.toMatchObject({
      sessionId: fixture.firstSessionId,
      inserted: true,
    });
    await expect(recovery).resolves.toEqual({
      attempted: 1,
      projected: 1,
      failed: 0,
    });
    expect(fixture.count("audio_items")).toBe(1);
    expect(fixture.count("durable_receipts")).toBe(1);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "capture-projection-"));
  roots.push(root);
  const profile = profilePathsForRoot(path.join(root, "profile"));
  await mkdir(profile.mediaDirectory, { recursive: true });
  const mediaPath = path.join(profile.mediaDirectory, "capture.wav");
  const bytes = Buffer.concat([Buffer.alloc(44), Buffer.alloc(3_200)]);
  await writeFile(mediaPath, bytes);
  const normalizedSha256 = createHash("sha256").update(bytes).digest("hex");
  const database = openAudioDatabase(":memory:");
  const firstSessionId = "session-library-first-123456";
  const secondSessionId = "session-library-second-123456";
  for (const sessionId of [firstSessionId, secondSessionId]) {
    database
      .prepare(
        `INSERT INTO capture_sessions (
          session_id, title, workspace_path, state, capture_mode,
          recording_sha256, journal_sha256, created_at_ms, updated_at_ms
        ) VALUES (?, 'Capture', ?, 'completed', 'dual_track', ?, ?, 1000, 1000)`,
      )
      .run(
        sessionId,
        path.join(profile.captureDirectory, sessionId),
        "d".repeat(64),
        "d".repeat(64),
      );
  }
  const media = {
    normalizedPath: mediaPath,
    normalizedSha256,
    sourceSha256: "d".repeat(64),
    normalizedSizeBytes: bytes.length,
    durationMs: 100,
    receipt: { schemaVersion: 1, kind: "capture-formal" },
  };
  const domain = new DesktopDomainService(
    new DesktopRepository(database, profile),
    () => 5_000,
  );
  return {
    database,
    media,
    firstSessionId,
    secondSessionId,
    captureRepository: new CaptureRepository(database),
    service: (
      prepareMedia: (sessionId: string) => Promise<typeof media> = async () =>
        media,
    ) =>
      new CaptureLibraryProjectionService({
        profile,
        domain,
        prepareMedia,
      }),
    count: (table: string) =>
      Number(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
      ),
    captureState: () =>
      String(
        database
          .prepare("SELECT state FROM capture_sessions WHERE session_id = ?")
          .get(firstSessionId)?.state,
      ),
    addCapture: (
      sessionId: string,
      options: {
        state?: "completed" | "partial_capture";
        updatedAtMs?: number;
      } = {},
    ) => {
      database
        .prepare(
          `INSERT INTO capture_sessions (
            session_id, title, workspace_path, state, capture_mode,
            recording_sha256, journal_sha256, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, 'dual_track', ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          sessionId,
          path.join(profile.captureDirectory, sessionId),
          options.state ?? "completed",
          "d".repeat(64),
          "d".repeat(64),
          options.updatedAtMs ?? 1_000,
          options.updatedAtMs ?? 1_000,
        );
    },
    authorizeStop: (sessionId: string) => {
      const row = database
        .prepare("SELECT * FROM capture_sessions WHERE session_id = ?")
        .get(sessionId)!;
      const result = captureSnapshotSchema.parse({
        sessionId,
        state: row.state,
        captureMode: row.capture_mode,
        captureTimelineMs: Number(row.capture_timeline_ms),
        systemAudioHealthy: Boolean(row.system_audio_healthy),
        microphoneHealthy: Boolean(row.microphone_healthy),
        partialCapture: Boolean(row.partial_capture),
        finalizedChunkCount: Number(row.finalized_chunk_count),
        eventCount: Number(row.event_count),
        gapCount: Number(row.gap_count),
        interruptionReason: row.interruption_reason,
        recordingSha256: row.recording_sha256,
        journalSha256: row.journal_sha256,
      });
      database
        .prepare(
          `INSERT INTO capture_command_receipts (
            session_id, idempotency_key, action, result_json, created_at_ms
          ) VALUES (?, ?, 'stop', ?, ?)`,
        )
        .run(sessionId, `stop:${sessionId}`, JSON.stringify(result), 2_000);
    },
    keepPartial: (sessionId: string) => {
      database
        .prepare(
          `UPDATE capture_sessions
           SET state = 'partial_capture', partial_capture = 1,
             recovery_disposition = 'kept'
           WHERE session_id = ?`,
        )
        .run(sessionId);
    },
    captureRows: () =>
      database
        .prepare(
          `SELECT session_id, state, recording_sha256, journal_sha256,
             recovery_disposition, updated_at_ms
           FROM capture_sessions ORDER BY session_id`,
        )
        .all(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
