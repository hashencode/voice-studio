import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  AudioProfileError,
  initializeAudioProfile,
  profilePathsForApplicationData,
} from "../../../src/main/profile/audio_profile";
import {
  AUDIO_APPLICATION_ID,
  AUDIO_SCHEMA_VERSION,
  AudioStorageCompatibilityError,
  AudioStorageCorruptionError,
  openAudioDatabase,
  openAudioProfileDatabase,
  withTransaction,
} from "../../../src/main/storage/audio_database";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "voice2text-electron-storage-"));
  temporaryRoots.push(root);
  return root;
}

describe("Electron SQLite v2", () => {
  it("keeps SQLite's in-memory sentinel off disk", () => {
    const database = openAudioDatabase(":memory:");
    try {
      expect(database.prepare("PRAGMA database_list").get()?.file).toBe("");
    } finally {
      database.close();
    }
  });

  it("creates the fresh schema with its application identity and foreign keys", () => {
    const initialized = initializeAudioProfile(temporaryRoot());
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const database = initialized.database;

    try {
      expect(
        database.prepare("PRAGMA application_id").get()?.application_id,
      ).toBe(AUDIO_APPLICATION_ID);
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        AUDIO_SCHEMA_VERSION,
      );
      expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
        1,
      );
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(
        expect.arrayContaining([
          "audio_items",
          "processing_jobs",
          "audio_notes",
          "durable_receipts",
          "result_publications",
        ]),
      );

      expect(() =>
        database
          .prepare(
            "INSERT INTO processing_jobs (audio_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'queued', 0, 1, 1)",
          )
          .run(999, "missing-audio", "operation", "resource"),
      ).toThrow();

      database.exec(`
        INSERT INTO audio_items (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms)
        VALUES
          ('audio-a', 'source-a', 'Audio A', '/media-a.wav', 1, 1, 1),
          ('audio-b', 'source-b', 'Audio B', '/media-b.wav', 1, 1, 1);
        INSERT INTO processing_jobs (audio_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms)
        VALUES
          (1, 'job-a', 'asr', 'resource', 'queued', 0, 1, 1),
          (2, 'job-b', 'asr', 'resource', 'queued', 0, 1, 1);
      `);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM processing_jobs WHERE operation_id = 'asr'",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it("rejects unversioned, old, or future databases instead of migrating them", () => {
    const root = temporaryRoot();
    const databasePath = join(root, "audio.sqlite3");
    const versionZero = new DatabaseSync(databasePath);
    versionZero.exec(`
      CREATE TABLE migration_probe (value TEXT NOT NULL);
      INSERT INTO migration_probe (value) VALUES ('preserved');
      PRAGMA user_version = 0;
    `);
    versionZero.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(
      AudioStorageCompatibilityError,
    );
    const preserved = new DatabaseSync(databasePath);
    expect(
      preserved.prepare("SELECT value FROM migration_probe").get(),
    ).toEqual({ value: "preserved" });
    preserved.close();

    const oldPath = join(root, "old.sqlite3");
    const old = new DatabaseSync(oldPath);
    old.exec(`
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = ${AUDIO_SCHEMA_VERSION - 1};
      CREATE TABLE old_probe (value TEXT NOT NULL);
      INSERT INTO old_probe VALUES ('preserved');
    `);
    old.close();
    expect(() => openAudioDatabase(oldPath)).toThrow(
      AudioStorageCompatibilityError,
    );
    const preservedOld = new DatabaseSync(oldPath);
    expect(preservedOld.prepare("PRAGMA user_version").get()).toEqual({
      user_version: AUDIO_SCHEMA_VERSION - 1,
    });
    preservedOld.close();

    const futurePath = join(root, "future.sqlite3");
    const future = new DatabaseSync(futurePath);
    future.exec(`
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = ${AUDIO_SCHEMA_VERSION + 1};
      CREATE TABLE future_probe (value TEXT NOT NULL);
      INSERT INTO future_probe VALUES ('preserved');
    `);
    future.close();
    expect(() => openAudioDatabase(futurePath)).toThrow(
      AudioStorageCompatibilityError,
    );
    const preservedFuture = new DatabaseSync(futurePath);
    expect(preservedFuture.prepare("PRAGMA user_version").get()).toEqual({
      user_version: AUDIO_SCHEMA_VERSION + 1,
    });
    preservedFuture.close();
  });

  it("rolls a failed transaction back completely", () => {
    const database = openAudioDatabase(join(temporaryRoot(), "rollback.db"));
    try {
      expect(() =>
        withTransaction(database, () => {
          database
            .prepare(
              "INSERT INTO audio_items (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run("rollback", "source", "Rollback", "/media.wav", 1, 1, 1);
          throw new Error("force rollback");
        }),
      ).toThrow("force rollback");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM audio_items").get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects a corrupt or structurally incomplete Electron database", () => {
    const corruptPath = join(temporaryRoot(), "corrupt.db");
    writeFileSync(corruptPath, "this is not sqlite");
    expect(() => openAudioDatabase(corruptPath)).toThrow(
      AudioStorageCorruptionError,
    );

    const incompletePath = join(temporaryRoot(), "incomplete.db");
    const incomplete = new DatabaseSync(incompletePath);
    incomplete.exec(`
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = ${AUDIO_SCHEMA_VERSION};
    `);
    incomplete.close();
    expect(() => openAudioDatabase(incompletePath)).toThrow(
      AudioStorageCorruptionError,
    );
  });
});

describe("independent Electron profile", () => {
  it("creates only its own profile and never inspects a Flutter sibling", () => {
    const root = temporaryRoot();
    const flutterDatabase = join(root, "flutter-desktop", "database", "app.db");
    mkdirSync(join(root, "flutter-desktop", "database"), { recursive: true });
    writeFileSync(flutterDatabase, "flutter-profile-poison");

    const initialized = initializeAudioProfile(root);
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const profile = initialized.profile;
    initialized.database.close();

    expect(profile.root).toBe(join(root, "voice2text-electron", "v2"));
    expect(profile.databasePath).not.toBe(flutterDatabase);
    expect(readFileSync(flutterDatabase, "utf8")).toBe(
      "flutter-profile-poison",
    );
  });

  it("rejects a profile database path outside its declared root", () => {
    const root = temporaryRoot();
    const profile = profilePathsForApplicationData(root);
    expect(() =>
      openAudioProfileDatabase({
        ...profile,
        databasePath: join(root, "flutter-desktop", "app.db"),
      }),
    ).toThrow(AudioProfileError);
  });
});
