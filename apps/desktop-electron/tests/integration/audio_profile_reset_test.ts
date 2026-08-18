import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
import { DesktopApplicationState } from "../../src/main/application/application_state";

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

function seedMeetingEraDatabaseWithUncheckpointedWal(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const database = new DatabaseSync(process.argv[1]);
       database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meetings (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO meetings (display_name) VALUES ('wal-only row');");
       process.exit(0);`,
      path,
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(existsSync(`${path}-wal`)).toBe(true);
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
        /meetings\.sqlite3\.meeting-era\.20260817T080910011Z\.archive\/meetings\.sqlite3$/,
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

  it("atomically archives the complete legacy SQLite bundle including uncheckpointed WAL data", () => {
    const applicationDataRoot = temporaryRoot();
    const legacyPath =
      legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
    seedMeetingEraDatabaseWithUncheckpointedWal(legacyPath);

    const result = initializeAudioProfile(applicationDataRoot, {
      now: () => Date.UTC(2026, 7, 17, 8, 9, 10, 11),
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);

    try {
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}-wal`)).toBe(false);
      expect(result.archivedLegacyDatabasePath).toMatch(
        /meetings\.sqlite3\.meeting-era\.20260817T080910011Z\.archive\/meetings\.sqlite3$/,
      );
      expect(existsSync(`${result.archivedLegacyDatabasePath}-wal`)).toBe(true);
      const archived = new DatabaseSync(result.archivedLegacyDatabasePath!);
      expect(
        archived.prepare("SELECT display_name FROM meetings").get(),
      ).toEqual({ display_name: "wal-only row" });
      archived.close();
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

  it("restores every legacy SQLite member when bundle staging fails midway", () => {
    const applicationDataRoot = temporaryRoot();
    const legacyPath =
      legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
    seedMeetingEraDatabaseWithUncheckpointedWal(legacyPath);
    const members = [legacyPath, `${legacyPath}-wal`, `${legacyPath}-shm`];
    const before = new Map(members.map((path) => [path, readFileSync(path)]));
    let moveCount = 0;

    const result = initializeAudioProfile(applicationDataRoot, {
      archiveLegacyDatabase: (source, destination) => {
        renameSync(source, destination);
        moveCount += 1;
        if (moveCount === 2) throw new Error("simulated bundle move failure");
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "legacy_archive_failed",
      }),
    );
    for (const member of members) {
      expect(readFileSync(member)).toEqual(before.get(member));
    }
    expect(
      existsSync(join(applicationDataRoot, "voice2text-electron", "archive"))
        ? readdirSync(
            join(applicationDataRoot, "voice2text-electron", "archive"),
          )
        : [],
    ).toEqual([]);
  });

  it("projects only a non-sensitive archive fact into the ready application snapshot", () => {
    const applicationDataRoot = temporaryRoot();
    const legacyPath =
      legacyMeetingDatabasePathForApplicationData(applicationDataRoot);
    seedMeetingEraDatabase(legacyPath);
    const result = initializeAudioProfile(applicationDataRoot);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);

    try {
      const snapshot = new DesktopApplicationState().completeBootstrap(result);
      expect(snapshot.profile).toEqual({
        phase: "ready",
        legacyDatabaseArchived: true,
      });
      expect(JSON.stringify(snapshot)).not.toContain(applicationDataRoot);
    } finally {
      result.database.close();
    }
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
