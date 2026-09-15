import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CaptureLibraryProjectionService } from "../../src/main/domain/capture/capture_library_projection_service";
import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { profilePathsForRoot } from "../../src/main/profile/profile_paths";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";

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
    firstSessionId,
    secondSessionId,
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
  };
}
