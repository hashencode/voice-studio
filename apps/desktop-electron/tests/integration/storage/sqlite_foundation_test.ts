import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  ElectronProfileError,
  initializeElectronProfile,
  profilePathsForApplicationData,
} from "../../../src/main/profile/electron_profile";
import {
  ELECTRON_APPLICATION_ID,
  ELECTRON_SCHEMA_VERSION,
  StorageCorruptionError,
  openElectronDatabase,
  openElectronProfileDatabase,
  withTransaction,
} from "../../../src/main/storage/database";
import { createSchemaV1 } from "../../../src/main/storage/migrations/v1";

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

describe("Electron SQLite v1", () => {
  it("creates the fresh schema with its application identity and foreign keys", () => {
    const initialized = initializeElectronProfile(temporaryRoot());
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const database = initialized.database;

    try {
      expect(
        database.prepare("PRAGMA application_id").get()?.application_id,
      ).toBe(ELECTRON_APPLICATION_ID);
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        ELECTRON_SCHEMA_VERSION,
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
          "meetings",
          "processing_jobs",
          "meeting_notes",
          "durable_receipts",
          "result_publications",
        ]),
      );

      expect(() =>
        database
          .prepare(
            "INSERT INTO processing_jobs (meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'queued', 0, 1, 1)",
          )
          .run(999, "missing-meeting", "operation", "resource"),
      ).toThrow();

      database.exec(`
        INSERT INTO meetings (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms)
        VALUES
          ('meeting-a', 'source-a', 'Meeting A', '/media-a.wav', 1, 1, 1),
          ('meeting-b', 'source-b', 'Meeting B', '/media-b.wav', 1, 1, 1);
        INSERT INTO processing_jobs (meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms)
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

  it("migrates an Electron version-zero database forward without losing data", () => {
    const root = temporaryRoot();
    const databasePath = join(root, "meeting.sqlite3");
    const versionZero = new DatabaseSync(databasePath);
    versionZero.exec(`
      CREATE TABLE migration_probe (value TEXT NOT NULL);
      INSERT INTO migration_probe (value) VALUES ('preserved');
      PRAGMA user_version = 0;
    `);
    versionZero.close();

    const migrated = openElectronDatabase(databasePath);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        ELECTRON_SCHEMA_VERSION,
      );
      expect(
        migrated.prepare("SELECT value FROM migration_probe").get()?.value,
      ).toBe("preserved");
    } finally {
      migrated.close();
    }
  });

  it("migrates v1 jobs forward with a durable cancellation-intent column", () => {
    const databasePath = join(temporaryRoot(), "schema-v1.db");
    const versionOne = new DatabaseSync(databasePath);
    createSchemaV1(versionOne);
    versionOne.exec(`
      INSERT INTO meetings (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms)
      VALUES ('meeting', 'source', 'Meeting', '/media.wav', 1, 1, 1);
      INSERT INTO processing_jobs (meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, source_identity, deadline_at_ms, created_at_ms, updated_at_ms)
      VALUES (1, 'job', 'operation', 'resource', 'running', 1, 'worker', 5000, 1, 1);
      INSERT INTO result_publications (meeting_id, job_id, operation_id, attempt, source_identity, payload_json, created_at_ms)
      VALUES (1, 1, 'operation', 1, 'worker', '{"segments":[]}', 1);
      UPDATE meetings SET active_publication_id = 1 WHERE id = 1;
      CREATE UNIQUE INDEX legacy_processing_jobs_operation_unique
        ON processing_jobs(operation_id);
      PRAGMA application_id = ${ELECTRON_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    versionOne.close();

    const migrated = openElectronDatabase(databasePath);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        ELECTRON_SCHEMA_VERSION,
      );
      expect(
        migrated
          .prepare("PRAGMA table_info(processing_jobs)")
          .all()
          .map((column) => column.name),
      ).toContain("cancel_requested_at_ms");
      expect(
        migrated
          .prepare(
            "SELECT meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, source_identity, deadline_at_ms FROM processing_jobs WHERE id = 1",
          )
          .get(),
      ).toEqual({
        meeting_id: 1,
        idempotency_key: "job",
        operation_id: "operation",
        resource_identity: "resource",
        state: "running",
        attempt: 1,
        source_identity: "worker",
        deadline_at_ms: 5000,
      });
      expect(
        migrated
          .prepare(
            "SELECT id, meeting_id, job_id, operation_id, attempt, source_identity, payload_json FROM result_publications WHERE id = 1",
          )
          .get(),
      ).toEqual({
        id: 1,
        meeting_id: 1,
        job_id: 1,
        operation_id: "operation",
        attempt: 1,
        source_identity: "worker",
        payload_json: '{"segments":[]}',
      });
      expect(
        migrated.prepare("SELECT active_publication_id FROM meetings").get()
          ?.active_publication_id,
      ).toBe(1);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('processing_jobs', 'result_publications') ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(
        expect.arrayContaining([
          "processing_jobs_claim_order",
          "result_publications_meeting_order",
        ]),
      );
      migrated.exec(`
        INSERT INTO meetings (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms)
        VALUES ('meeting-2', 'source-2', 'Meeting 2', '/media-2.wav', 1, 2, 2);
        INSERT INTO processing_jobs (meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms)
        VALUES (2, 'job-2', 'operation', 'resource-2', 'queued', 0, 2, 2);
      `);
    } finally {
      migrated.close();
    }
  });

  it("rolls a failed transaction back completely", () => {
    const database = openElectronDatabase(join(temporaryRoot(), "rollback.db"));
    try {
      expect(() =>
        withTransaction(database, () => {
          database
            .prepare(
              "INSERT INTO meetings (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run("rollback", "source", "Rollback", "/media.wav", 1, 1, 1);
          throw new Error("force rollback");
        }),
      ).toThrow("force rollback");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM meetings").get()?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects a corrupt or structurally incomplete Electron database", () => {
    const corruptPath = join(temporaryRoot(), "corrupt.db");
    writeFileSync(corruptPath, "this is not sqlite");
    expect(() => openElectronDatabase(corruptPath)).toThrow(
      StorageCorruptionError,
    );

    const incompletePath = join(temporaryRoot(), "incomplete.db");
    const incomplete = new DatabaseSync(incompletePath);
    incomplete.exec(`
      PRAGMA application_id = ${ELECTRON_APPLICATION_ID};
      PRAGMA user_version = ${ELECTRON_SCHEMA_VERSION};
    `);
    incomplete.close();
    expect(() => openElectronDatabase(incompletePath)).toThrow(
      StorageCorruptionError,
    );
  });
});

describe("independent Electron profile", () => {
  it("creates only its own profile and never inspects a Flutter sibling", () => {
    const root = temporaryRoot();
    const flutterDatabase = join(root, "flutter-desktop", "database", "app.db");
    mkdirSync(join(root, "flutter-desktop", "database"), { recursive: true });
    writeFileSync(flutterDatabase, "flutter-profile-poison");

    const initialized = initializeElectronProfile(root);
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const profile = initialized.profile;
    initialized.database.close();

    expect(profile.root).toBe(join(root, "voice2text-electron", "v1"));
    expect(profile.databasePath).not.toBe(flutterDatabase);
    expect(readFileSync(flutterDatabase, "utf8")).toBe(
      "flutter-profile-poison",
    );
  });

  it("rejects a profile database path outside its declared root", () => {
    const root = temporaryRoot();
    const profile = profilePathsForApplicationData(root);
    expect(() =>
      openElectronProfileDatabase({
        ...profile,
        databasePath: join(root, "flutter-desktop", "app.db"),
      }),
    ).toThrow(ElectronProfileError);
  });
});
