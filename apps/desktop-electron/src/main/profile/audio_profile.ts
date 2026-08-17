import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  AUDIO_SCHEMA_VERSION,
  AudioStorageError,
  openAudioProfileDatabase,
} from "../storage/audio_database";
import { syncDirectory, writeJsonAtomically } from "./atomic_json";
import {
  AudioProfileError,
  assertAudioProfilePaths,
  assertProfileOwnedPath,
  assertProfileTreeContained,
  profilePathsForApplicationData,
  profilePathsForRoot,
  pathEntryExists,
  type AudioProfilePaths,
} from "./profile_paths";
import {
  reconcileAudioProfile,
  type StartupReconciliationReport,
} from "./reconciliation";

export {
  AudioProfileError,
  assertAudioProfilePaths,
  assertProfileOwnedPath,
  profilePathsForApplicationData,
  profilePathsForApplicationData as audioProfilePathsForApplicationData,
};
export type { AudioProfilePaths };

const DEFAULT_MINIMUM_FREE_BYTES = 512n * 1024n * 1024n;

export interface AudioProfileInitializationOptions {
  minimumFreeBytes?: bigint;
  freeSpaceProbe?: (path: string) => bigint;
  now?: () => number;
  archiveLegacyDatabase?: (source: string, destination: string) => void;
}

export type AudioProfileInitializationResult =
  | {
      status: "ready";
      profile: AudioProfilePaths;
      database: DatabaseSync;
      reconciliation: StartupReconciliationReport;
      archivedLegacyDatabasePath: string | null;
    }
  | {
      status: "blocked";
      code:
        | "filesystem_unavailable"
        | "legacy_archive_failed"
        | "insufficient_space"
        | "path_escape"
        | "schema_invalid";
      message: string;
      repairable: true;
    };

export function initializeAudioProfile(
  applicationDataRoot: string,
  options: AudioProfileInitializationOptions = {},
): AudioProfileInitializationResult {
  const minimumFreeBytes =
    options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
  const freeSpaceProbe = options.freeSpaceProbe ?? availableBytes;
  const now = options.now ?? Date.now;
  let archivedLegacyDatabasePath: string | null;
  let database: DatabaseSync | undefined;

  try {
    archivedLegacyDatabasePath = archiveLegacyMeetingDatabase(
      applicationDataRoot,
      now(),
      options.archiveLegacyDatabase ?? renameSync,
    );
  } catch (error) {
    return blocked("legacy_archive_failed", error);
  }

  try {
    const finalProfile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(applicationDataRoot, { recursive: true, mode: 0o700 });
    assertProfileTreeContained(applicationDataRoot, finalProfile);
    const profileContainer = dirname(finalProfile.root);
    if (
      pathEntryExists(profileContainer) &&
      lstatSync(profileContainer).isSymbolicLink()
    ) {
      throw new AudioProfileError(
        "Electron profile container is a symbolic link",
      );
    }
    mkdirSync(profileContainer, { recursive: true, mode: 0o700 });
    assertProfileTreeContained(applicationDataRoot, finalProfile);

    const finalExists = pathEntryExists(finalProfile.root);
    const workingProfile = finalExists
      ? finalProfile
      : profilePathsForRoot(`${finalProfile.root}.initializing`);
    if (
      pathEntryExists(workingProfile.root) &&
      lstatSync(workingProfile.root).isSymbolicLink()
    ) {
      throw new AudioProfileError(
        "Electron profile initialization path is a symbolic link",
      );
    }
    mkdirSync(workingProfile.root, { recursive: true, mode: 0o700 });
    for (const directory of workingProfile.requiredDirectories) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    assertProfileTreeContained(applicationDataRoot, workingProfile);
    for (const directory of workingProfile.requiredDirectories) {
      assertDirectoryWritable(directory);
    }
    assertProfileOwnedPath(workingProfile, workingProfile.databasePath);
    removeReadyMarker(workingProfile.readyMarkerPath);

    const freeBytes = freeSpaceProbe(workingProfile.root);
    if (freeBytes < minimumFreeBytes) {
      return {
        status: "blocked",
        code: "insufficient_space",
        message: `Electron profile requires ${minimumFreeBytes} free bytes but only ${freeBytes} are available`,
        repairable: true,
      };
    }

    database = openAudioProfileDatabase(workingProfile);
    const reconciliation = reconcileAudioProfile(
      database,
      workingProfile,
      now(),
    );
    writeJsonAtomically(workingProfile.readyMarkerPath, {
      schema: "voice2text-electron-profile-ready/v1",
      status: "ready",
      databaseSchemaVersion: AUDIO_SCHEMA_VERSION,
      reconciledAtMs: reconciliation.reconciledAtMs,
      repairableItemCount: reconciliation.items.length,
    });

    if (!finalExists) {
      database.close();
      database = undefined;
      renameSync(workingProfile.root, finalProfile.root);
      syncDirectory(profileContainer);
      assertProfileTreeContained(applicationDataRoot, finalProfile);
      database = openAudioProfileDatabase(finalProfile);
      return {
        status: "ready",
        profile: finalProfile,
        database,
        archivedLegacyDatabasePath,
        reconciliation: relocateReport(
          reconciliation,
          workingProfile,
          finalProfile,
        ),
      };
    }

    return {
      status: "ready",
      profile: finalProfile,
      database,
      reconciliation,
      archivedLegacyDatabasePath,
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the initialization error as the repair signal.
    }
    if (error instanceof AudioProfileError) {
      return blocked("path_escape", error);
    }
    if (error instanceof AudioStorageError) {
      return blocked("schema_invalid", error);
    }
    return blocked("filesystem_unavailable", error);
  }
}

export function legacyMeetingDatabasePathForApplicationData(
  applicationDataRoot: string,
): string {
  return join(
    resolve(applicationDataRoot),
    "voice2text-electron",
    "v1",
    "database",
    "meetings.sqlite3",
  );
}

function archiveLegacyMeetingDatabase(
  applicationDataRoot: string,
  nowMs: number,
  archive: (source: string, destination: string) => void,
): string | null {
  const legacyPath =
    legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
  try {
    if (!lstatSync(legacyPath).isFile()) {
      throw new Error("Meeting-era database is not a regular file");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing legacy tree (including an ancestor that is not a directory)
    // means there is no legacy database to archive. Active-profile setup below
    // remains responsible for classifying collisions in its own path.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  const archiveDirectory = join(
    resolve(applicationDataRoot),
    "voice2text-electron",
    "archive",
  );
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const destination = join(
    archiveDirectory,
    `meetings.sqlite3.meeting-era.${archiveTimestamp(nowMs)}.archive`,
  );
  if (existsSync(destination)) {
    throw new Error("Meeting-era archive destination already exists");
  }
  archive(legacyPath, destination);
  syncDirectory(dirname(legacyPath));
  syncDirectory(archiveDirectory);
  return destination;
}

function archiveTimestamp(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Archive timestamp is invalid");
  }
  return new Date(nowMs).toISOString().replace(/[-:.]/g, "");
}

function availableBytes(path: string): bigint {
  const stats = statfsSync(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

function assertDirectoryWritable(directory: string): void {
  const probe = `${directory}/.write-probe-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(probe, "wx", 0o600);
    writeSync(descriptor, "profile-write-probe", undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    unlinkSync(probe);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the write or durability failure.
      }
    }
    try {
      unlinkSync(probe);
    } catch {
      // If creation failed there is no probe to remove.
    }
    throw error;
  }
}

function removeReadyMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function relocateReport(
  report: StartupReconciliationReport,
  from: AudioProfilePaths,
  to: AudioProfilePaths,
): StartupReconciliationReport {
  return {
    ...report,
    items: report.items.map((item) => ({
      ...item,
      receiptPath: item.receiptPath.replace(from.root, to.root),
    })),
  };
}

function blocked(
  code: Extract<
    AudioProfileInitializationResult,
    { status: "blocked" }
  >["code"],
  error: unknown,
): AudioProfileInitializationResult {
  return {
    status: "blocked",
    code,
    message: error instanceof Error ? error.message : String(error),
    repairable: true,
  };
}
