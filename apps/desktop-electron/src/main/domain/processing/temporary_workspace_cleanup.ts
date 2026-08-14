import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

export function cleanupExpiredTemporaryWorkspaces(
  workspaceRoot: string,
  nowMs = Date.now(),
  maximumAgeMs = TWENTY_FOUR_HOURS_MS,
): string[] {
  const root = resolve(workspaceRoot);
  assertNoSymlinkComponents(root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("temporary workspace root is not a private directory");
  }
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    assertStableDirectory(root, rootStat);
    const candidate = join(root, entry.name);
    assertContained(root, candidate);
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (nowMs - stat.mtimeMs < maximumAgeMs) continue;
    removeTreeWithoutFollowingLinks(root, rootStat, candidate);
    removed.push(basename(candidate));
  }
  return removed.sort();
}

export async function cleanupExpiredOrphanedImportedMedia(
  mediaRoot: string,
  authoritativePaths: Iterable<string>,
  discard: (path: string) => Promise<void>,
  nowMs = Date.now(),
  maximumAgeMs = TWENTY_FOUR_HOURS_MS,
): Promise<string[]> {
  const root = resolve(mediaRoot);
  assertNoSymlinkComponents(root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("media root is not a private directory");
  }
  const complete = join(root, "complete");
  let completeStat: Stats;
  try {
    completeStat = lstatSync(complete);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  assertNoSymlinkComponents(complete);
  if (!completeStat.isDirectory() || completeStat.isSymbolicLink()) {
    throw new Error("completed import root is not a private directory");
  }
  const authorities = new Set(
    [...authoritativePaths]
      .map((candidate) => resolve(candidate))
      .filter((candidate) => dirname(candidate) === complete),
  );
  const removed: string[] = [];
  for (const entry of readdirSync(complete, { withFileTypes: true })) {
    assertStableDirectory(root, rootStat);
    assertStableDirectory(complete, completeStat);
    const candidate = join(complete, entry.name);
    assertContained(complete, candidate);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
    if (authorities.has(candidate)) continue;
    if (nowMs - stat.mtimeMs < maximumAgeMs) continue;
    await discard(candidate);
    removed.push(entry.name);
  }
  return removed.sort();
}

function removeTreeWithoutFollowingLinks(
  root: string,
  rootStat: Stats,
  candidate: string,
): void {
  assertStableDirectory(root, rootStat);
  assertContained(root, candidate);
  assertNoSymlinkComponents(dirname(candidate));
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    unlinkSync(candidate);
    return;
  }
  for (const entry of readdirSync(candidate)) {
    assertStableDirectory(candidate, stat);
    removeTreeWithoutFollowingLinks(root, rootStat, join(candidate, entry));
  }
  assertStableDirectory(candidate, stat);
  rmdirSync(candidate);
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute
    .slice(root.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("temporary workspace path contains a symlink ancestor");
    }
  }
}

function assertStableDirectory(path: string, expected: Stats): void {
  assertNoSymlinkComponents(path);
  const current = lstatSync(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error("temporary workspace directory identity changed");
  }
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, resolve(candidate));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("temporary workspace escaped its capability root");
  }
}
