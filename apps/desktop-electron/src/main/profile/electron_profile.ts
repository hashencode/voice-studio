import {
  closeSync,
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
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ELECTRON_SCHEMA_VERSION,
  StorageError,
  openElectronProfileDatabase,
} from "../storage/database";
import { syncDirectory, writeJsonAtomically } from "./atomic_json";
import {
  ElectronProfileError,
  assertElectronProfilePaths,
  assertProfileOwnedPath,
  assertProfileTreeContained,
  profilePathsForApplicationData,
  profilePathsForRoot,
  pathEntryExists,
  type ElectronProfilePaths,
} from "./profile_paths";
import {
  reconcileElectronProfile,
  type StartupReconciliationReport,
} from "./reconciliation";

export {
  ElectronProfileError,
  assertElectronProfilePaths,
  assertProfileOwnedPath,
  profilePathsForApplicationData,
};
export type { ElectronProfilePaths };

const DEFAULT_MINIMUM_FREE_BYTES = 512n * 1024n * 1024n;

export interface ElectronProfileInitializationOptions {
  minimumFreeBytes?: bigint;
  freeSpaceProbe?: (path: string) => bigint;
  now?: () => number;
}

export type ElectronProfileInitializationResult =
  | {
      status: "ready";
      profile: ElectronProfilePaths;
      database: DatabaseSync;
      reconciliation: StartupReconciliationReport;
    }
  | {
      status: "blocked";
      code:
        | "filesystem_unavailable"
        | "insufficient_space"
        | "path_escape"
        | "schema_invalid";
      message: string;
      repairable: true;
    };

export function initializeElectronProfile(
  applicationDataRoot: string,
  options: ElectronProfileInitializationOptions = {},
): ElectronProfileInitializationResult {
  const minimumFreeBytes =
    options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
  const freeSpaceProbe = options.freeSpaceProbe ?? availableBytes;
  const now = options.now ?? Date.now;
  let database: DatabaseSync | undefined;

  try {
    const finalProfile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(applicationDataRoot, { recursive: true, mode: 0o700 });
    assertProfileTreeContained(applicationDataRoot, finalProfile);
    const profileContainer = dirname(finalProfile.root);
    if (
      pathEntryExists(profileContainer) &&
      lstatSync(profileContainer).isSymbolicLink()
    ) {
      throw new ElectronProfileError(
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
      throw new ElectronProfileError(
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

    database = openElectronProfileDatabase(workingProfile);
    const reconciliation = reconcileElectronProfile(
      database,
      workingProfile,
      now(),
    );
    writeJsonAtomically(workingProfile.readyMarkerPath, {
      schema: "voice2text-electron-profile-ready/v1",
      status: "ready",
      databaseSchemaVersion: ELECTRON_SCHEMA_VERSION,
      reconciledAtMs: reconciliation.reconciledAtMs,
      repairableItemCount: reconciliation.items.length,
    });

    if (!finalExists) {
      database.close();
      database = undefined;
      renameSync(workingProfile.root, finalProfile.root);
      syncDirectory(profileContainer);
      assertProfileTreeContained(applicationDataRoot, finalProfile);
      database = openElectronProfileDatabase(finalProfile);
      return {
        status: "ready",
        profile: finalProfile,
        database,
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
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the initialization error as the repair signal.
    }
    if (error instanceof ElectronProfileError) {
      return blocked("path_escape", error);
    }
    if (error instanceof StorageError) {
      return blocked("schema_invalid", error);
    }
    return blocked("filesystem_unavailable", error);
  }
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
  from: ElectronProfilePaths,
  to: ElectronProfilePaths,
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
    ElectronProfileInitializationResult,
    { status: "blocked" }
  >["code"],
  error: unknown,
): ElectronProfileInitializationResult {
  return {
    status: "blocked",
    code,
    message: error instanceof Error ? error.message : String(error),
    repairable: true,
  };
}
