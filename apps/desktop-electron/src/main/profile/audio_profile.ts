import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openAudioDatabase } from "../storage/audio_database";
import { syncDirectory } from "./atomic_json";

export interface AudioProfilePaths {
  root: string;
  databaseDirectory: string;
  databasePath: string;
  readyMarkerPath: string;
}

export interface AudioProfileInitializationOptions {
  now?: () => number;
  archiveLegacyDatabase?: (source: string, destination: string) => void;
}

export type AudioProfileInitializationResult =
  | {
      status: "ready";
      profile: AudioProfilePaths;
      database: DatabaseSync;
      archivedLegacyDatabasePath: string | null;
    }
  | {
      status: "blocked";
      code: "legacy_archive_failed" | "filesystem_unavailable";
      message: string;
      repairable: true;
    };

export function audioProfilePathsForApplicationData(
  applicationDataRoot: string,
): AudioProfilePaths {
  const root = join(resolve(applicationDataRoot), "voice2text-electron", "v2");
  const databaseDirectory = join(root, "database");
  return {
    root,
    databaseDirectory,
    databasePath: join(databaseDirectory, "audio.sqlite3"),
    readyMarkerPath: join(root, ".audio-profile-ready.json"),
  };
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

export function initializeAudioProfile(
  applicationDataRoot: string,
  options: AudioProfileInitializationOptions = {},
): AudioProfileInitializationResult {
  const profile = audioProfilePathsForApplicationData(applicationDataRoot);
  const legacyPath =
    legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
  let archivedLegacyDatabasePath: string | null = null;

  if (existsSync(legacyPath)) {
    try {
      if (!lstatSync(legacyPath).isFile()) {
        throw new Error("Meeting-era database is not a regular file");
      }
      const container = join(
        resolve(applicationDataRoot),
        "voice2text-electron",
      );
      const archiveDirectory = join(container, "archive");
      mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
      archivedLegacyDatabasePath = join(
        archiveDirectory,
        `meetings.sqlite3.meeting-era.${archiveTimestamp(
          (options.now ?? Date.now)(),
        )}.archive`,
      );
      if (existsSync(archivedLegacyDatabasePath)) {
        throw new Error("Meeting-era archive destination already exists");
      }
      (options.archiveLegacyDatabase ?? renameSync)(
        legacyPath,
        archivedLegacyDatabasePath,
      );
      syncDirectory(dirname(legacyPath));
      syncDirectory(archiveDirectory);
    } catch (error) {
      return {
        status: "blocked",
        code: "legacy_archive_failed",
        message:
          error instanceof Error
            ? `Meeting-era database archive failed: ${error.message}`
            : "Meeting-era database archive failed",
        repairable: true,
      };
    }
  }

  try {
    mkdirSync(profile.databaseDirectory, { recursive: true, mode: 0o700 });
    const database = openAudioDatabase(profile.databasePath);
    return {
      status: "ready",
      profile,
      database,
      archivedLegacyDatabasePath,
    };
  } catch (error) {
    return {
      status: "blocked",
      code: "filesystem_unavailable",
      message: error instanceof Error ? error.message : String(error),
      repairable: true,
    };
  }
}

function archiveTimestamp(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Archive timestamp is invalid");
  }
  return new Date(nowMs).toISOString().replace(/[-:.]/g, "");
}
