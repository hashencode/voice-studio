import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateCaptureAuthority } from "../../src/main/domain/capture/capture_authority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("capture authority validation", () => {
  it("rehashes a bounded journal and every declared authority chunk", async () => {
    const fixture = createFixture();
    await expect(validateCaptureAuthority(fixture.request)).resolves.toEqual(
      expect.objectContaining({
        sessionId: fixture.sessionId,
        chunks: [expect.objectContaining({ sha256: fixture.chunkSha256 })],
      }),
    );
  });

  it("fails closed on hash mismatch and symlink replacement", async () => {
    const mismatch = createFixture();
    await expect(
      validateCaptureAuthority({
        ...mismatch.request,
        expectedJournalSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/hash mismatch/);

    const replaced = createFixture();
    const outside = path.join(replaced.root, "outside.caf");
    writeFileSync(outside, "outside");
    unlinkSync(replaced.chunkPath);
    symlinkSync(outside, replaced.chunkPath);
    await expect(validateCaptureAuthority(replaced.request)).rejects.toThrow(
      /regular file/,
    );
  });

  it.each(["journal", "chunk"] as const)(
    "rejects deterministic %s replacement after the no-follow fd is pinned",
    async (kind) => {
      const fixture = createFixture();
      let replaced = false;
      await expect(
        validateCaptureAuthority({
          ...fixture.request,
          afterPinnedOpenForTesting(openedKind, filePath) {
            if (openedKind !== kind || replaced) return;
            replaced = true;
            renameSync(filePath, `${filePath}.pinned-original`);
            writeFileSync(filePath, "attacker replacement");
          },
        }),
      ).rejects.toThrow(/replaced while hashing/);
    },
  );
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "voice2text-authority-"));
  roots.push(root);
  const sessionId = "session-authority-123456";
  const session = path.join(root, sessionId);
  mkdirSync(path.join(session, "microphone"), { recursive: true });
  const chunkPath = path.join(session, "microphone/chunk-000000.caf");
  const chunk = Buffer.from("capture authority fixture\n");
  writeFileSync(chunkPath, chunk);
  const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
  const journalPath = path.join(session, "journal.json");
  writeFileSync(
    journalPath,
    JSON.stringify({
      schema: "desktop-capture-session/v1",
      sessionId,
      captureMode: "microphone_only",
      tracks: [
        {
          kind: "microphone",
          healthy: true,
          sampleRate: 48_000,
          channels: 1,
          format: "float32",
        },
      ],
      chunks: [
        {
          track: "microphone",
          sequence: 0,
          startMs: 0,
          endMs: 1_000,
          relativePath: "microphone/chunk-000000.caf",
          bytes: chunk.byteLength,
          sha256: chunkSha256,
          finalized: true,
        },
      ],
      events: [],
    }),
  );
  const expectedJournalSha256 = createHash("sha256")
    .update(readFileSync(journalPath))
    .digest("hex");
  return {
    root,
    sessionId,
    chunkPath,
    chunkSha256,
    request: { captureRoot: root, sessionId, expectedJournalSha256 },
  };
}
