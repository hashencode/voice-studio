import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ElectronProfilePaths {
  root: string;
  databaseDirectory: string;
  databasePath: string;
  mediaDirectory: string;
  workspaceDirectory: string;
}

export class ElectronProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectronProfileError";
  }
}

export function initializeElectronProfile(
  applicationDataRoot: string,
): ElectronProfilePaths {
  if (applicationDataRoot.trim().length === 0) {
    throw new ElectronProfileError("Electron application-data root is empty");
  }

  const root = join(resolve(applicationDataRoot), "voice2text-electron", "v1");
  const profile: ElectronProfilePaths = {
    root,
    databaseDirectory: join(root, "database"),
    databasePath: join(root, "database", "meetings.sqlite3"),
    mediaDirectory: join(root, "media"),
    workspaceDirectory: join(root, "workspaces"),
  };
  assertElectronProfilePaths(profile);
  mkdirSync(profile.databaseDirectory, { recursive: true });
  mkdirSync(profile.mediaDirectory, { recursive: true });
  mkdirSync(profile.workspaceDirectory, { recursive: true });
  return profile;
}

export function assertElectronProfilePaths(
  profile: ElectronProfilePaths,
): void {
  const root = resolve(profile.root);
  const expectedDatabaseDirectory = join(root, "database");
  const expectedDatabasePath = join(
    expectedDatabaseDirectory,
    "meetings.sqlite3",
  );
  const expectedMediaDirectory = join(root, "media");
  const expectedWorkspaceDirectory = join(root, "workspaces");

  for (const [label, actual, expected] of [
    [
      "database directory",
      profile.databaseDirectory,
      expectedDatabaseDirectory,
    ],
    ["database path", profile.databasePath, expectedDatabasePath],
    ["media directory", profile.mediaDirectory, expectedMediaDirectory],
    [
      "workspace directory",
      profile.workspaceDirectory,
      expectedWorkspaceDirectory,
    ],
  ] as const) {
    if (resolve(actual) !== expected || !isInside(root, actual)) {
      throw new ElectronProfileError(
        `Electron ${label} is outside the versioned profile`,
      );
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}
