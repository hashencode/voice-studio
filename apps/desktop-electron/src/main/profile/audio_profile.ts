import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
  removeLegacyDatabaseMember?: (path: string) => void;
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
      options.archiveLegacyDatabase ?? copyFileSync,
      options.removeLegacyDatabaseMember ?? unlinkSync,
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
  remove: (path: string) => void,
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
    if (code === "ENOENT" || code === "ENOTDIR") {
      return publishedLegacyArchivePath(applicationDataRoot);
    }
    throw error;
  }
  assertLegacyDatabaseAncestorsAreDirectories(applicationDataRoot);

  const archiveDirectory = join(
    resolve(applicationDataRoot),
    "voice2text-electron",
    "archive",
  );
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const archiveBundleName = `meetings.sqlite3.meeting-era.${archiveTimestamp(nowMs)}.archive`;
  const destinationDirectory = join(archiveDirectory, archiveBundleName);
  if (existsSync(destinationDirectory)) {
    throw new Error("Meeting-era archive destination already exists");
  }
  const stagingDirectory = join(
    archiveDirectory,
    `.${archiveBundleName}.staging-${process.pid}-${randomUUID()}`,
  );
  const members = legacyDatabaseMembers(legacyPath);
  mkdirSync(stagingDirectory, { mode: 0o700 });
  try {
    for (const source of members) {
      copyVerifiedArchiveMember(
        source,
        join(stagingDirectory, source.slice(dirname(source).length + 1)),
        archive,
      );
    }
    syncDirectory(stagingDirectory);
    renameSync(stagingDirectory, destinationDirectory);
    syncDirectory(archiveDirectory);
    for (const source of members) {
      if (existsSync(source)) remove(source);
    }
    syncDirectory(dirname(legacyPath));
    syncDirectory(archiveDirectory);
    return join(destinationDirectory, "meetings.sqlite3");
  } catch (error) {
    try {
      restoreLegacyDatabaseMembers({
        legacyDirectory: dirname(legacyPath),
        members,
        stagingDirectory,
        destinationDirectory,
      });
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Meeting-era archive failed and could not be restored",
      );
    }
    throw error;
  }
}

function assertLegacyDatabaseAncestorsAreDirectories(
  applicationDataRoot: string,
): void {
  const root = resolve(applicationDataRoot);
  const ancestors = [
    join(root, "voice2text-electron"),
    join(root, "voice2text-electron", "v1"),
    join(root, "voice2text-electron", "v1", "database"),
  ];
  for (const ancestor of ancestors) {
    const metadata = lstatSync(ancestor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Meeting-era database ancestor is not a directory");
    }
  }
}

function publishedLegacyArchivePath(
  applicationDataRoot: string,
): string | null {
  const archiveDirectory = join(
    resolve(applicationDataRoot),
    "voice2text-electron",
    "archive",
  );
  let entries: string[];
  try {
    entries = readdirSync(archiveDirectory).sort().reverse();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  for (const entry of entries) {
    if (
      !/^meetings\.sqlite3\.meeting-era\.\d{8}T\d{9}Z\.archive$/.test(entry)
    ) {
      continue;
    }
    const published = join(archiveDirectory, entry);
    try {
      const publishedMetadata = lstatSync(published);
      if (publishedMetadata.isFile()) return published;
      if (!publishedMetadata.isDirectory()) continue;
      const candidate = join(published, "meetings.sqlite3");
      if (lstatSync(candidate).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

function copyVerifiedArchiveMember(
  source: string,
  destination: string,
  archive: (source: string, destination: string) => void,
): void {
  const sourceFingerprint = fileFingerprint(source);
  archive(source, destination);
  fsyncFile(destination);
  const stagedFingerprint = fileFingerprint(destination);
  if (
    stagedFingerprint.size !== sourceFingerprint.size ||
    stagedFingerprint.sha256 !== sourceFingerprint.sha256
  ) {
    throw new Error("Meeting-era archive copy did not match its source");
  }
}

function fileFingerprint(path: string): { size: number; sha256: string } {
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    throw new Error("Meeting-era SQLite member is not a regular file");
  }
  const descriptor = openSync(path, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) {
        throw new Error("Meeting-era SQLite member changed while archiving");
      }
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    return { size: metadata.size, sha256: digest.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function legacyDatabaseMembers(legacyPath: string): string[] {
  const members = [
    legacyPath,
    `${legacyPath}-wal`,
    `${legacyPath}-shm`,
    `${legacyPath}-journal`,
  ];
  return members.filter((path) => {
    try {
      if (!lstatSync(path).isFile()) {
        throw new Error("Meeting-era SQLite member is not a regular file");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

function restoreLegacyDatabaseMembers(options: {
  legacyDirectory: string;
  members: readonly string[];
  stagingDirectory: string;
  destinationDirectory: string;
}): void {
  if (existsSync(options.destinationDirectory)) {
    if (existsSync(options.stagingDirectory)) {
      throw new Error("Meeting-era archive has two rollback sources");
    }
    renameSync(options.destinationDirectory, options.stagingDirectory);
  }
  for (const source of [...options.members].reverse()) {
    const staged = join(
      options.stagingDirectory,
      source.slice(options.legacyDirectory.length + 1),
    );
    if (!existsSync(staged)) continue;
    if (existsSync(source)) {
      unlinkSync(staged);
    } else {
      renameSync(staged, source);
    }
  }
  if (existsSync(options.stagingDirectory)) {
    if (readdirSync(options.stagingDirectory).length > 0) {
      throw new Error("Meeting-era archive rollback left unknown members");
    }
    rmdirSync(options.stagingDirectory);
  }
  syncDirectory(options.legacyDirectory);
  syncDirectory(dirname(options.destinationDirectory));
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
  void error;
  return {
    status: "blocked",
    code,
    message: blockedMessage(code),
    repairable: true,
  };
}

function blockedMessage(
  code: Extract<
    AudioProfileInitializationResult,
    { status: "blocked" }
  >["code"],
): string {
  switch (code) {
    case "legacy_archive_failed":
      return "无法归档旧版资料库；请检查存储与权限后重试。";
    case "insufficient_space":
      return "可用存储空间不足；请释放空间后重试。";
    case "path_escape":
      return "本机资料库路径不可用；请检查资料库目录后重试。";
    case "schema_invalid":
      return "本机 Audio 资料库不可用；请修复资料库后重试。";
    case "filesystem_unavailable":
      return "无法初始化本机 Audio 资料库；请检查存储与权限后重试。";
  }
}
