import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validatePinnedMediaAuthority } from "../../src/main/security/pinned_media_authority";

describe("U11 reused normalized media authority", () => {
  const ownedRoots: string[] = [];
  afterEach(() => {
    for (const root of ownedRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an unchanged fd-pinned regular authority", async () => {
    const fixture = mediaFixture();
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing committed authority", async () => {
    const fixture = mediaFixture();
    rmSync(fixture.authority.authorityPath);
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).rejects.toThrow();
  });

  it("rejects a truncated committed authority", async () => {
    const fixture = mediaFixture();
    writeFileSync(
      fixture.authority.authorityPath,
      fixture.bytes.subarray(0, 4),
    );
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).rejects.toThrow();
  });

  it("rejects a same-size wrong-hash committed authority", async () => {
    const fixture = mediaFixture();
    writeFileSync(
      fixture.authority.authorityPath,
      Buffer.alloc(fixture.bytes.length, 0x7f),
    );
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).rejects.toThrow();
  });

  it("rejects a symlink substituted for committed authority", async () => {
    const fixture = mediaFixture();
    const target = path.join(fixture.root, "outside.wav");
    writeFileSync(target, fixture.bytes, { mode: 0o600 });
    rmSync(fixture.authority.authorityPath);
    symlinkSync(target, fixture.authority.authorityPath);
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).rejects.toThrow();
  });

  it("rejects a symlink substituted for the complete directory", async () => {
    const fixture = mediaFixture();
    const replacement = path.join(fixture.root, "replacement");
    mkdirSync(replacement, { mode: 0o700 });
    const replacementFile = path.join(replacement, "audio.wav");
    writeFileSync(replacementFile, fixture.bytes, { mode: 0o600 });
    rmSync(fixture.authority.authorityPath);
    rmSync(fixture.authority.authorityDirectory, { recursive: true });
    symlinkSync(replacement, fixture.authority.authorityDirectory);
    await expect(
      validatePinnedMediaAuthority(fixture.authority),
    ).rejects.toThrow();
  });

  function mediaFixture() {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "voice2text-media-authority-")),
    );
    ownedRoots.push(root);
    chmodSync(root, 0o700);
    const directory = path.join(root, "complete");
    mkdirSync(directory, { mode: 0o700 });
    const authorityPath = path.join(directory, "audio.wav");
    const bytes = Buffer.from("bounded normalized audio authority", "utf8");
    writeFileSync(authorityPath, bytes, { mode: 0o600 });
    return {
      root,
      bytes,
      authority: {
        authorityPath,
        authorityDirectory: directory,
        expectedBytes: bytes.length,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
});
