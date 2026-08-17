import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface AudioProfilePaths {
  root: string;
  databaseDirectory: string;
  databasePath: string;
  mediaDirectory: string;
  workspaceDirectory: string;
  captureDirectory: string;
  stagingDirectory: string;
  aiWorkspaceDirectory: string;
  transferDirectory: string;
  reconciliationDirectory: string;
  readyMarkerPath: string;
  requiredDirectories: readonly string[];
}

export class AudioProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioProfileError";
  }
}

export function profilePathsForApplicationData(
  applicationDataRoot: string,
): AudioProfilePaths {
  if (applicationDataRoot.trim().length === 0) {
    throw new AudioProfileError("Electron application-data root is empty");
  }
  return profilePathsForRoot(
    join(resolve(applicationDataRoot), "voice2text-electron", "v2"),
  );
}

export function profilePathsForRoot(rootPath: string): AudioProfilePaths {
  const profile = profilePathsWithoutValidation(rootPath);
  assertAudioProfilePaths(profile);
  return profile;
}

export function assertAudioProfilePaths(profile: AudioProfilePaths): void {
  const expected = profilePathsWithoutValidation(profile.root);
  for (const [label, actual, expectedPath] of [
    [
      "database directory",
      profile.databaseDirectory,
      expected.databaseDirectory,
    ],
    ["database path", profile.databasePath, expected.databasePath],
    ["media directory", profile.mediaDirectory, expected.mediaDirectory],
    [
      "workspace directory",
      profile.workspaceDirectory,
      expected.workspaceDirectory,
    ],
    ["capture directory", profile.captureDirectory, expected.captureDirectory],
    ["staging directory", profile.stagingDirectory, expected.stagingDirectory],
    [
      "AI workspace directory",
      profile.aiWorkspaceDirectory,
      expected.aiWorkspaceDirectory,
    ],
    [
      "transfer directory",
      profile.transferDirectory,
      expected.transferDirectory,
    ],
    [
      "reconciliation directory",
      profile.reconciliationDirectory,
      expected.reconciliationDirectory,
    ],
    ["ready marker", profile.readyMarkerPath, expected.readyMarkerPath],
  ] as const) {
    if (
      resolve(actual) !== expectedPath ||
      !isLexicallyInside(profile.root, actual)
    ) {
      throw new AudioProfileError(
        `Electron ${label} is outside the versioned profile`,
      );
    }
  }
}

export function assertProfileTreeContained(
  applicationDataRoot: string,
  profile: AudioProfilePaths,
): void {
  const canonicalApplicationData = realpathSync(resolve(applicationDataRoot));
  for (const path of [profile.root, ...profile.requiredDirectories]) {
    if (!pathEntryExists(path)) continue;
    if (lstatSync(path).isSymbolicLink()) {
      throw new AudioProfileError(
        "Electron profile contains a symbolic-link path",
      );
    }
    const canonical = realpathSync(path);
    if (!isLexicallyInside(canonicalApplicationData, canonical)) {
      throw new AudioProfileError(
        "Electron profile escapes the application-data root",
      );
    }
  }
}

export function assertProfileOwnedPath(
  profile: AudioProfilePaths,
  candidate: string,
): void {
  if (!isLexicallyInside(profile.root, candidate)) {
    throw new AudioProfileError("Path is outside the Electron profile");
  }
  let existing = resolve(candidate);
  while (!pathEntryExists(existing) && existing !== dirname(existing)) {
    existing = dirname(existing);
  }
  if (lstatSync(existing).isSymbolicLink()) {
    throw new AudioProfileError("Electron profile path is a symbolic link");
  }
  const canonicalRoot = realpathSync(profile.root);
  const canonicalExisting = realpathSync(existing);
  if (
    canonicalExisting !== canonicalRoot &&
    !isLexicallyInside(canonicalRoot, canonicalExisting)
  ) {
    throw new AudioProfileError("Path escapes the Electron profile");
  }
}

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function profilePathsWithoutValidation(rootPath: string): AudioProfilePaths {
  const root = resolve(rootPath);
  const databaseDirectory = join(root, "database");
  const mediaDirectory = join(root, "media");
  const workspaceDirectory = join(root, "workspaces");
  const captureDirectory = join(workspaceDirectory, "capture");
  const stagingDirectory = join(workspaceDirectory, "staging");
  const aiWorkspaceDirectory = join(workspaceDirectory, "ai");
  const transferDirectory = join(workspaceDirectory, "transfers");
  const reconciliationDirectory = join(workspaceDirectory, "reconciliation");

  return {
    root,
    databaseDirectory,
    databasePath: join(databaseDirectory, "audio.sqlite3"),
    mediaDirectory,
    workspaceDirectory,
    captureDirectory,
    stagingDirectory,
    aiWorkspaceDirectory,
    transferDirectory,
    reconciliationDirectory,
    readyMarkerPath: join(root, ".audio-profile-ready.json"),
    requiredDirectories: [
      databaseDirectory,
      mediaDirectory,
      workspaceDirectory,
      captureDirectory,
      stagingDirectory,
      aiWorkspaceDirectory,
      transferDirectory,
      reconciliationDirectory,
    ],
  };
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}
