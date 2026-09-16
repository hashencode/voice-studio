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
import { createFrozenAudioV4Schema } from "../../fixtures/frozen_audio_v4";

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
      expect(
        database
          .prepare("PRAGMA table_info(audio_items)")
          .all()
          .map((column) => column.name),
      ).toEqual(
        expect.arrayContaining([
          "display_name",
          "original_name",
          "description",
        ]),
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
        INSERT INTO audio_items (idempotency_key, source_identity, display_name, original_name, media_path, duration_ms, created_at_ms, updated_at_ms)
        VALUES
          ('audio-a', 'source-a', 'Audio A', 'Audio A', '/media-a.wav', 1, 1, 1),
          ('audio-b', 'source-b', 'Audio B', 'Audio B', '/media-b.wav', 1, 1, 1);
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

  it("upgrades a frozen v4 database and preserves reserved draft metadata and notes", () => {
    const databasePath = join(temporaryRoot(), "audio-v4.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    createFrozenAudioV4Schema(legacy);
    legacy.exec(`
      INSERT INTO audio_items (
        id, idempotency_key, source_identity, display_name, media_path,
        duration_ms, created_at_ms, updated_at_ms
      ) VALUES
        (1, 'audio-1', 'source-1', '当前标题', '/media-1.wav', 1, 1, 1),
        (2, 'audio-2', 'source-2', '历史标题', '/media-2.wav', 2, 2, 2);
      INSERT INTO audio_notes (
        id, audio_id, idempotency_key, body, created_at_ms, updated_at_ms
      ) VALUES
        (1, 1, 'workspace-title-origin:1', '首次标题', 1, 1),
        (2, 1, 'workspace-description:1', '迁移描述', 1, 1),
        (3, 1, 'ordinary-note', '普通笔记', 1, 1);
      INSERT INTO processing_jobs (
        id, audio_id, idempotency_key, operation_id, resource_identity,
        state, attempt, created_at_ms, updated_at_ms
      ) VALUES (1, 1, 'job-1', 'asr', 'resource-1', 'completed', 1, 1, 1);
      INSERT INTO result_publications (
        id, audio_id, job_id, operation_id, attempt, source_identity,
        payload_json, created_at_ms
      ) VALUES (1, 1, 1, 'asr', 1, 'source-1', '{}', 1);
      INSERT INTO audio_generations (
        id, audio_id, publication_id, kind, attempt, created_at_ms
      ) VALUES (1, 1, 1, 'formal', 1, 1);
      INSERT INTO transcript_segments (
        id, audio_id, generation_id, stable_key, sequence_id, machine_text,
        text, text_source, start_ms, end_ms, review_state, speaker_state,
        speaker_source, created_at_ms, updated_at_ms
      ) VALUES (
        1, 1, 1, 'segment-1', 0, '迁移前文本', '迁移前文本', 'machine',
        0, 1000, 'unreviewed', 'unknown', 'machine', 1, 1
      );
      INSERT INTO workspace_heads (audio_id, revision, updated_at_ms)
      VALUES (1, 7, 1);
      INSERT INTO ai_provider_profiles (
        profile_id, kind, protocol, model_id, endpoint, secret_ref,
        created_at_ms, updated_at_ms
      ) VALUES (
        'profile-1', 'custom', 'openai-compatible', 'model-1',
        'https://example.invalid/v1', 'secret-1', 1, 1
      );
      INSERT INTO capture_sessions (
        session_id, title, workspace_path, state, capture_mode,
        created_at_ms, updated_at_ms
      ) VALUES (
        'capture-1', '迁移前录音', '/capture-1', 'completed',
        'microphone_only', 1, 1
      );
      UPDATE companion_settings
      SET receiver_enabled = 1, revision = 3, updated_at_ms = 1
      WHERE id = 1;
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = 4;
    `);
    const notesBefore = legacy
      .prepare("SELECT * FROM audio_notes ORDER BY id")
      .all();
    const businessRowsBefore = {
      processingJob: legacy.prepare("SELECT * FROM processing_jobs").get(),
      publication: legacy.prepare("SELECT * FROM result_publications").get(),
      generation: legacy.prepare("SELECT * FROM audio_generations").get(),
      transcriptSegment: legacy
        .prepare("SELECT * FROM transcript_segments")
        .get(),
      workspaceHead: legacy.prepare("SELECT * FROM workspace_heads").get(),
      aiProfile: legacy.prepare("SELECT * FROM ai_provider_profiles").get(),
      captureSession: legacy.prepare("SELECT * FROM capture_sessions").get(),
      companionSettings: legacy
        .prepare("SELECT * FROM companion_settings")
        .get(),
    };
    legacy.close();

    const migrated = openAudioDatabase(databasePath);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 5,
      });
      expect(
        migrated
          .prepare(
            "SELECT id, display_name, original_name, description FROM audio_items ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          display_name: "当前标题",
          original_name: "首次标题",
          description: "迁移描述",
        },
        {
          id: 2,
          display_name: "历史标题",
          original_name: "历史标题",
          description: "",
        },
      ]);
      expect(
        migrated.prepare("SELECT * FROM audio_notes ORDER BY id").all(),
      ).toEqual(notesBefore);
      expect({
        processingJob: migrated.prepare("SELECT * FROM processing_jobs").get(),
        publication: migrated
          .prepare("SELECT * FROM result_publications")
          .get(),
        generation: migrated.prepare("SELECT * FROM audio_generations").get(),
        transcriptSegment: migrated
          .prepare("SELECT * FROM transcript_segments")
          .get(),
        workspaceHead: migrated.prepare("SELECT * FROM workspace_heads").get(),
        aiProfile: migrated.prepare("SELECT * FROM ai_provider_profiles").get(),
        captureSession: migrated
          .prepare("SELECT * FROM capture_sessions")
          .get(),
        companionSettings: migrated
          .prepare("SELECT * FROM companion_settings")
          .get(),
      }).toEqual(businessRowsBefore);
      expect(
        migrated
          .prepare("PRAGMA table_info(audio_items)")
          .all()
          .filter((column) =>
            ["original_name", "description"].includes(String(column.name)),
          )
          .map((column) => ({ name: column.name, notnull: column.notnull })),
      ).toEqual([
        { name: "original_name", notnull: 1 },
        { name: "description", notnull: 1 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("rolls back v4 migration when reserved metadata belongs to another audio", () => {
    const databasePath = join(temporaryRoot(), "audio-v4-conflict.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    createFrozenAudioV4Schema(legacy);
    legacy.exec(`
      INSERT INTO audio_items (
        id, idempotency_key, source_identity, display_name, media_path,
        duration_ms, created_at_ms, updated_at_ms
      ) VALUES
        (1, 'audio-1', 'source-1', 'Audio 1', '/media-1.wav', 1, 1, 1),
        (2, 'audio-2', 'source-2', 'Audio 2', '/media-2.wav', 2, 2, 2);
      INSERT INTO audio_notes (
        audio_id, idempotency_key, body, created_at_ms, updated_at_ms
      ) VALUES (2, 'workspace-description:1', 'wrong owner', 1, 1);
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = 4;
    `);
    legacy.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(/reserved metadata/i);
    const preserved = new DatabaseSync(databasePath);
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 4,
      });
      expect(
        preserved
          .prepare("PRAGMA table_info(audio_items)")
          .all()
          .map((column) => column.name),
      ).not.toContain("original_name");
    } finally {
      preserved.close();
    }
  });

  it("rolls back a v4 migration failure after schema changes and can retry", () => {
    const databasePath = join(temporaryRoot(), "audio-v4-post-alter.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    createFrozenAudioV4Schema(legacy);
    legacy.exec(`
      INSERT INTO audio_items (
        id, idempotency_key, source_identity, display_name, media_path,
        duration_ms, created_at_ms, updated_at_ms
      ) VALUES (1, 'audio-1', 'source-1', '', '/media-1.wav', 1, 1, 1);
      PRAGMA application_id = ${AUDIO_APPLICATION_ID};
      PRAGMA user_version = 4;
    `);
    legacy.close();

    expect(() => openAudioDatabase(databasePath)).toThrow(
      /length\(original_name\) > 0/i,
    );
    const preserved = new DatabaseSync(databasePath);
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 4,
      });
      expect(
        preserved
          .prepare("PRAGMA table_info(audio_items)")
          .all()
          .map((column) => column.name),
      ).not.toContain("original_name");
      preserved
        .prepare("UPDATE audio_items SET display_name = ? WHERE id = 1")
        .run("恢复标题");
    } finally {
      preserved.close();
    }

    const retried = openAudioDatabase(databasePath);
    try {
      expect(retried.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 5,
      });
      expect(
        retried
          .prepare("SELECT original_name FROM audio_items WHERE id = 1")
          .get(),
      ).toEqual({ original_name: "恢复标题" });
    } finally {
      retried.close();
    }
  });

  it("rejects unversioned, pre-v4, or future databases instead of migrating them", () => {
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
      PRAGMA user_version = 3;
      CREATE TABLE old_probe (value TEXT NOT NULL);
      INSERT INTO old_probe VALUES ('preserved');
    `);
    old.close();
    expect(() => openAudioDatabase(oldPath)).toThrow(
      AudioStorageCompatibilityError,
    );
    const preservedOld = new DatabaseSync(oldPath);
    expect(preservedOld.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 3,
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
              "INSERT INTO audio_items (idempotency_key, source_identity, display_name, original_name, media_path, duration_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              "rollback",
              "source",
              "Rollback",
              "Rollback",
              "/media.wav",
              1,
              1,
              1,
            );
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
