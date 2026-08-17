import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIO_APPLICATION_ID,
  AUDIO_SCHEMA_VERSION,
  AudioStorageCompatibilityError,
  openAudioDatabase,
} from "../../src/main/storage/audio_database";
import {
  audioProfilePathsForApplicationData,
  initializeAudioProfile,
  legacyMeetingDatabasePathForApplicationData,
} from "../../src/main/profile/audio_profile";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "voice2text-audio-profile-"));
  temporaryRoots.push(root);
  return root;
}

function seedMeetingEraDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL);
    INSERT INTO meetings (display_name) VALUES ('must not load');
    PRAGMA application_id = 1446130757;
    PRAGMA user_version = 10;
  `);
  database.close();
}

describe("U8 Audio profile reset boundary", () => {
  it("creates a fresh Audio v1 database for a fresh install", () => {
    const applicationDataRoot = temporaryRoot();
    const result = initializeAudioProfile(applicationDataRoot);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);

    try {
      expect(result.archivedLegacyDatabasePath).toBeNull();
      expect(result.profile.root).toBe(
        join(applicationDataRoot, "voice2text-electron", "v2"),
      );
      expect(result.profile.databasePath).toBe(
        join(result.profile.root, "database", "audio.sqlite3"),
      );
      expect(result.database.prepare("PRAGMA application_id").get()).toEqual({
        application_id: AUDIO_APPLICATION_ID,
      });
      expect(result.database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: AUDIO_SCHEMA_VERSION,
      });
      expect(
        result.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toContain("audio_items");
    } finally {
      result.database.close();
    }
  });

  it("archives a Meeting-era database before creating an unrelated Audio database", () => {
    const applicationDataRoot = temporaryRoot();
    const legacyPath =
      legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
    seedMeetingEraDatabase(legacyPath);

    const result = initializeAudioProfile(applicationDataRoot, {
      now: () => Date.UTC(2026, 7, 17, 8, 9, 10, 11),
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);

    try {
      expect(existsSync(legacyPath)).toBe(false);
      expect(result.archivedLegacyDatabasePath).toMatch(
        /meetings\.sqlite3\.meeting-era\.20260817T080910011Z\.archive$/,
      );
      const archived = new DatabaseSync(result.archivedLegacyDatabasePath!);
      expect(
        archived.prepare("SELECT display_name FROM meetings").get(),
      ).toEqual({ display_name: "must not load" });
      archived.close();
      expect(() =>
        result.database.prepare("SELECT * FROM meetings").all(),
      ).toThrow();
      expect(
        result.database
          .prepare("SELECT COUNT(*) AS count FROM audio_items")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      result.database.close();
    }
  });

  it("preserves the original and blocks fresh creation when archival fails", () => {
    const applicationDataRoot = temporaryRoot();
    const legacyPath =
      legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
    seedMeetingEraDatabase(legacyPath);
    const before = readFileSync(legacyPath);

    const result = initializeAudioProfile(applicationDataRoot, {
      archiveLegacyDatabase: () => {
        throw new Error("simulated archive failure");
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "legacy_archive_failed",
        repairable: true,
      }),
    );
    expect(readFileSync(legacyPath)).toEqual(before);
    const fresh = audioProfilePathsForApplicationData(applicationDataRoot);
    expect(existsSync(fresh.databasePath)).toBe(false);
    expect(existsSync(fresh.root)).toBe(false);
    const archiveDirectory = join(dirname(dirname(legacyPath)), "archive");
    expect(
      existsSync(archiveDirectory) ? readdirSync(archiveDirectory) : [],
    ).toEqual([]);
  });

  it("rejects a Meeting-era database instead of migrating or compatibility-reading it", () => {
    const root = temporaryRoot();
    const legacyPath = join(root, "meeting-era.sqlite3");
    seedMeetingEraDatabase(legacyPath);

    expect(() => openAudioDatabase(legacyPath)).toThrow(
      AudioStorageCompatibilityError,
    );
    const legacy = new DatabaseSync(legacyPath);
    expect(legacy.prepare("SELECT display_name FROM meetings").get()).toEqual({
      display_name: "must not load",
    });
    legacy.close();
  });
});
