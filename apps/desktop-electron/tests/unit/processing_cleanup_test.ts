import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  cleanupExpiredOrphanedImportedMedia,
  cleanupExpiredTemporaryWorkspaces,
} from "../../src/main/domain/processing/temporary_workspace_cleanup";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

it("removes only expired workspaces and never follows symlinks", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "voice2text-cleanup-"));
  roots.push(root);
  const attempts = join(root, "attempts");
  const outside = join(root, "outside");
  mkdirSync(join(attempts, "expired"), { recursive: true });
  mkdirSync(join(attempts, "fresh"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(attempts, "expired", "partial.json"), "remove");
  writeFileSync(join(attempts, "fresh", "partial.json"), "keep");
  writeFileSync(join(outside, "protected.txt"), "keep");
  symlinkSync(outside, join(attempts, "escape"));
  const old = new Date(1_000);
  utimesSync(join(attempts, "expired"), old, old);

  expect(cleanupExpiredTemporaryWorkspaces(attempts, 200_000_000)).toEqual([
    "expired",
  ]);
  expect(existsSync(join(attempts, "expired"))).toBe(false);
  expect(existsSync(join(attempts, "fresh"))).toBe(true);
  expect(existsSync(join(attempts, "escape"))).toBe(true);
  expect(existsSync(join(outside, "protected.txt"))).toBe(true);
});

it("fails closed when an ancestor of the workspace root becomes a symlink", () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "voice2text-cleanup-ancestor-"),
  );
  roots.push(root);
  const lexicalParent = join(root, "profile");
  const displacedParent = join(root, "profile-original");
  const attackerParent = join(root, "attacker");
  const attempts = join(lexicalParent, "attempts");
  const attackerAttempts = join(attackerParent, "attempts");
  mkdirSync(join(attempts, "expired"), { recursive: true });
  mkdirSync(join(attackerAttempts, "expired"), { recursive: true });
  const protectedPath = join(attackerAttempts, "expired", "protected.txt");
  writeFileSync(protectedPath, "keep");
  const old = new Date(1_000);
  utimesSync(join(attackerAttempts, "expired"), old, old);
  renameSync(lexicalParent, displacedParent);
  symlinkSync(attackerParent, lexicalParent, "dir");

  expect(() =>
    cleanupExpiredTemporaryWorkspaces(attempts, 200_000_000),
  ).toThrow(/symlink/i);
  expect(existsSync(protectedPath)).toBe(true);
});

it("discards only expired unclaimed completed imports", async () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "voice2text-media-cleanup-"),
  );
  roots.push(root);
  const complete = join(root, "complete");
  mkdirSync(complete);
  const authority = join(complete, "authority.wav");
  const orphan = join(complete, "orphan.wav");
  const fresh = join(complete, "fresh.wav");
  const hardLinked = join(complete, "hard-linked.wav");
  const outside = join(root, "outside.wav");
  writeFileSync(authority, "keep");
  writeFileSync(orphan, "remove");
  writeFileSync(fresh, "keep");
  writeFileSync(outside, "keep");
  linkSync(outside, hardLinked);
  symlinkSync(outside, join(complete, "symlink.wav"));
  const old = new Date(1_000);
  for (const candidate of [authority, orphan, hardLinked]) {
    utimesSync(candidate, old, old);
  }
  const discarded: string[] = [];

  const removed = await cleanupExpiredOrphanedImportedMedia(
    root,
    [authority],
    async (candidate) => {
      discarded.push(candidate);
      rmSync(candidate);
    },
    200_000_000,
  );

  expect(removed).toEqual(["orphan.wav"]);
  expect(discarded).toEqual([orphan]);
  expect(existsSync(authority)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(hardLinked)).toBe(true);
  expect(existsSync(join(complete, "symlink.wav"))).toBe(true);
  expect(existsSync(outside)).toBe(true);
});

it("fails closed when the completed-import directory is replaced by a symlink", async () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "voice2text-media-race-"),
  );
  roots.push(root);
  const complete = join(root, "complete");
  const displaced = join(root, "complete-original");
  const attacker = join(root, "attacker");
  mkdirSync(complete);
  mkdirSync(attacker);
  renameSync(complete, displaced);
  symlinkSync(attacker, complete, "dir");

  await expect(
    cleanupExpiredOrphanedImportedMedia(root, [], async () => undefined),
  ).rejects.toThrow(/symlink/i);
});
