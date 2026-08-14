import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ElectronProfilePaths {
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

export class ElectronProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectronProfileError";
  }
}

export function profilePathsForApplicationData(
  applicationDataRoot: string,
): ElectronProfilePaths {
  if (applicationDataRoot.trim().length === 0) {
    throw new ElectronProfileError("Electron application-data root is empty");
  }
  return profilePathsForRoot(
    join(resolve(applicationDataRoot), "voice2text-electron", "v1"),
  );
}

export function profilePathsForRoot(rootPath: string): ElectronProfilePaths {
  const root = resolve(rootPath);
  const databaseDirectory = join(root, "database");
  const mediaDirectory = join(root, "media");
  const workspaceDirectory = join(root, "workspaces");
  const profile: ElectronProfilePaths = {
    root,
    databaseDirectory,
    databasePath: join(databaseDirectory, "meetings.sqlite3"),
    mediaDirectory,
    workspaceDirectory,
    captureDirectory: join(workspaceDirectory, "capture"),
    stagingDirectory: join(workspaceDirectory, "staging"),
    aiWorkspaceDirectory: join(workspaceDirectory, "ai"),
    transferDirectory: join(workspaceDirectory, "transfers"),
    reconciliationDirectory: join(workspaceDirectory, "reconciliation"),
    readyMarkerPath: join(root, ".profile-ready.json"),
    requiredDirectories: [],
  };
  profile.requiredDirectories = [
    profile.databaseDirectory,
    profile.mediaDirectory,
    profile.workspaceDirectory,
    profile.captureDirectory,
    profile.stagingDirectory,
    profile.aiWorkspaceDirectory,
    profile.transferDirectory,
    profile.reconciliationDirectory,
  ];
  assertElectronProfilePaths(profile);
  return profile;
}

export function assertElectronProfilePaths(
  profile: ElectronProfilePaths,
): void {
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
      throw new ElectronProfileError(
        `Electron ${label} is outside the versioned profile`,
      );
    }
  }
}

export function assertProfileTreeContained(
  applicationDataRoot: string,
  profile: ElectronProfilePaths,
): void {
  const canonicalApplicationData = realpathSync(resolve(applicationDataRoot));
  for (const path of [profile.root, ...profile.requiredDirectories]) {
    if (!pathEntryExists(path)) continue;
    if (lstatSync(path).isSymbolicLink()) {
      throw new ElectronProfileError(
        "Electron profile contains a symbolic-link path",
      );
    }
    const canonical = realpathSync(path);
    if (!isLexicallyInside(canonicalApplicationData, canonical)) {
      throw new ElectronProfileError(
        "Electron profile escapes the application-data root",
      );
    }
  }
}

export function assertProfileOwnedPath(
  profile: ElectronProfilePaths,
  candidate: string,
): void {
  if (!isLexicallyInside(profile.root, candidate)) {
    throw new ElectronProfileError("Path is outside the Electron profile");
  }
  let existing = resolve(candidate);
  while (!pathEntryExists(existing) && existing !== dirname(existing)) {
    existing = dirname(existing);
  }
  if (lstatSync(existing).isSymbolicLink()) {
    throw new ElectronProfileError("Electron profile path is a symbolic link");
  }
  const canonicalRoot = realpathSync(profile.root);
  const canonicalExisting = realpathSync(existing);
  if (
    canonicalExisting !== canonicalRoot &&
    !isLexicallyInside(canonicalRoot, canonicalExisting)
  ) {
    throw new ElectronProfileError("Path escapes the Electron profile");
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

function profilePathsWithoutValidation(root: string) {
  const resolvedRoot = resolve(root);
  const databaseDirectory = join(resolvedRoot, "database");
  const workspaceDirectory = join(resolvedRoot, "workspaces");
  return {
    databaseDirectory,
    databasePath: join(databaseDirectory, "meetings.sqlite3"),
    mediaDirectory: join(resolvedRoot, "media"),
    workspaceDirectory,
    captureDirectory: join(workspaceDirectory, "capture"),
    stagingDirectory: join(workspaceDirectory, "staging"),
    aiWorkspaceDirectory: join(workspaceDirectory, "ai"),
    transferDirectory: join(workspaceDirectory, "transfers"),
    reconciliationDirectory: join(workspaceDirectory, "reconciliation"),
    readyMarkerPath: join(resolvedRoot, ".profile-ready.json"),
  };
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}
