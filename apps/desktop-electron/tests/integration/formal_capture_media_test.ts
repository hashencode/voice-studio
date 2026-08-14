import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { prepareFormalCaptureMedia } from "../../src/main/domain/captions/formal_capture_media";
import { profilePathsForRoot } from "../../src/main/profile/profile_paths";

it("builds one idempotent fd-validated 16k mono WAVE from the committed caption spool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "formal-media-"));
  try {
    const profile = profilePathsForRoot(path.join(root, "profile"));
    const sessionId = "session-formal-media-123456";
    const captionRoot = path.join(
      profile.captureDirectory,
      sessionId,
      "caption",
    );
    await mkdir(captionRoot, { recursive: true });
    await mkdir(profile.mediaDirectory, { recursive: true });
    const pcm = Buffer.alloc(3_200, 7);
    await writeFile(path.join(captionRoot, "live-caption.pcmspool"), pcm, {
      mode: 0o600,
    });
    const spoolSha256 = createHash("sha256").update(pcm).digest("hex");
    const journal = Buffer.from(
      JSON.stringify({
        schema: "desktop-capture-session/v1",
        sessionId,
        state: "completed",
        captureMode: "microphone_only",
        captureTimelineMs: 100,
        tracks: [
          {
            kind: "microphone",
            healthy: true,
            sampleRate: 48_000,
            channels: 1,
            format: "float32-planar",
          },
        ],
        chunks: [],
        events: [],
        spool: {
          relativePath: "caption/live-caption.pcmspool",
          format: "s16le",
          sampleRate: 16_000,
          channels: 1,
          frameDurationMs: 100,
          disposable: true,
          complete: true,
          formalEligible: true,
          bytes: pcm.byteLength,
          sha256: spoolSha256,
          durationMs: 100,
          captureTimelineMs: 100,
          gapCount: 0,
        },
      }),
    );
    await writeFile(
      path.join(profile.captureDirectory, sessionId, "journal.json"),
      journal,
      {
        mode: 0o600,
      },
    );
    const journalSha256 = createHash("sha256").update(journal).digest("hex");
    const command = {
      profile,
      sessionId,
      recordingSha256: journalSha256,
      journalSha256,
    };

    const first = await prepareFormalCaptureMedia(command);
    const replay = await prepareFormalCaptureMedia(command);
    const wav = await readFile(first.normalizedPath);

    expect(replay).toEqual(first);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.subarray(44)).toEqual(pcm);
    expect(first.durationMs).toBe(100);
    expect(first.normalizedSha256).toBe(
      createHash("sha256").update(wav).digest("hex"),
    );
    expect(first.receipt).toEqual(
      expect.objectContaining({
        recordingSha256: command.recordingSha256,
        journalSha256: command.journalSha256,
        spoolSha256,
        outputBytes: 3_244,
      }),
    );
    await rm(first.normalizedPath);
    await writeFile(
      path.join(captionRoot, "live-caption.pcmspool"),
      Buffer.alloc(3_200, 9),
    );
    await expect(prepareFormalCaptureMedia(command)).rejects.toThrow(
      /hash mismatched/i,
    );
    await expect(readFile(first.normalizedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path.join(captionRoot, "live-caption.pcmspool"), pcm, {
      mode: 0o600,
    });
    await expect(prepareFormalCaptureMedia(command)).resolves.toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
