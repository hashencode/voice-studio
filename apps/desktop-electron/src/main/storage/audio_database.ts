import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertAudioProfilePaths,
  type AudioProfilePaths,
} from "../profile/profile_paths";

import {
  AUDIO_APPLICATION_ID,
  AUDIO_SCHEMA_VERSION,
  createAudioSchemaV3,
  REQUIRED_AUDIO_SCHEMA_TABLES,
  REQUIRED_AUDIO_SCHEMA_TABLES_V1,
  REQUIRED_AUDIO_SCHEMA_TABLES_V2,
} from "./audio_schema";
import { migrateAudioSchemaV1ToV2 } from "./audio_migrations/v1_to_v2";
import {
  AudioSchemaMigrationConflictError,
  migrateAudioSchemaV2ToV3,
} from "./audio_migrations/v2_to_v3";

export { AUDIO_APPLICATION_ID, AUDIO_SCHEMA_VERSION } from "./audio_schema";

export class AudioStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioStorageError";
  }
}

export class AudioStorageCompatibilityError extends AudioStorageError {
  constructor(message: string) {
    super(message);
    this.name = "AudioStorageCompatibilityError";
  }
}

export class AudioStorageCorruptionError extends AudioStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioStorageCorruptionError";
  }
}

export function openAudioProfileDatabase(
  profile: AudioProfilePaths,
): DatabaseSync {
  assertAudioProfilePaths(profile);
  return openAudioDatabase(profile.databasePath);
}

export function openAudioDatabase(databasePath: string): DatabaseSync {
  const resolvedPath =
    databasePath === ":memory:" ? databasePath : resolve(databasePath);
  const existing =
    resolvedPath !== ":memory:" && hasNonEmptyDatabase(resolvedPath);
  const existingVersion = existing
    ? inspectExistingDatabase(resolvedPath)
    : null;
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(resolvedPath);
    configure(database);
    if (!existing) {
      database.exec("BEGIN IMMEDIATE");
      try {
        createAudioSchemaV3(database);
        database.exec(`PRAGMA application_id = ${AUDIO_APPLICATION_ID}`);
        database.exec(`PRAGMA user_version = ${AUDIO_SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } else if (existingVersion === 1 || existingVersion === 2) {
      const migratingDatabase = database;
      migratingDatabase.exec("PRAGMA foreign_keys = OFF");
      try {
        withTransaction(migratingDatabase, () => {
          if (existingVersion === 1) {
            migrateAudioSchemaV1ToV2(migratingDatabase);
            migratingDatabase.exec("PRAGMA user_version = 2");
            validateAudioSchema(migratingDatabase, 2);
          }
          migrateAudioSchemaV2ToV3(migratingDatabase);
          migratingDatabase.exec(
            `PRAGMA user_version = ${AUDIO_SCHEMA_VERSION}`,
          );
          validateAudioSchema(migratingDatabase, AUDIO_SCHEMA_VERSION);
        });
      } finally {
        migratingDatabase.exec("PRAGMA legacy_alter_table = OFF");
        migratingDatabase.exec("PRAGMA foreign_keys = ON");
      }
    }
    validateAudioSchema(database, AUDIO_SCHEMA_VERSION);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original failure.
    }
    if (error instanceof AudioStorageError) throw error;
    if (error instanceof AudioSchemaMigrationConflictError) {
      throw new AudioStorageCompatibilityError(error.message);
    }
    throw new AudioStorageCorruptionError(
      "Audio database could not be created or validated",
      { cause: error },
    );
  }
}

export function withTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function inspectExistingDatabase(path: string): number {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const applicationId = pragmaNumber(database, "application_id");
    const version = pragmaNumber(database, "user_version");
    if (applicationId !== AUDIO_APPLICATION_ID) {
      throw new AudioStorageCompatibilityError(
        "Existing database does not belong to the Audio store",
      );
    }
    if (version !== 1 && version !== 2 && version !== AUDIO_SCHEMA_VERSION) {
      throw new AudioStorageCompatibilityError(
        `Audio database schema version ${version} is unsupported`,
      );
    }
    validateAudioSchema(database, version);
    return version;
  } catch (error) {
    if (error instanceof AudioStorageError) throw error;
    throw new AudioStorageCorruptionError(
      "Existing Audio database could not be inspected",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

function hasNonEmptyDatabase(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function configure(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
}

function validateAudioSchema(
  database: DatabaseSync,
  expectedVersion: number,
): void {
  if (pragmaNumber(database, "application_id") !== AUDIO_APPLICATION_ID) {
    throw new AudioStorageCompatibilityError(
      "Audio database application identity does not match Audio",
    );
  }
  if (pragmaNumber(database, "user_version") !== expectedVersion) {
    throw new AudioStorageCompatibilityError(
      `Audio database schema version does not match Audio v${expectedVersion}`,
    );
  }
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  const requiredTables =
    expectedVersion === 1
      ? REQUIRED_AUDIO_SCHEMA_TABLES_V1
      : expectedVersion === 2
        ? REQUIRED_AUDIO_SCHEMA_TABLES_V2
        : REQUIRED_AUDIO_SCHEMA_TABLES;
  const missing = requiredTables.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new AudioStorageCorruptionError(
      `Audio database is missing schema tables: ${missing.join(", ")}`,
    );
  }
  if (expectedVersion >= 2) {
    assertProviderProfileSchema(database, expectedVersion);
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new AudioStorageCorruptionError(
      "Audio database has foreign-key damage",
    );
  }
  assertIntegrity(database);
}

function assertProviderProfileSchema(
  database: DatabaseSync,
  expectedVersion: number,
): void {
  const profileColumns = database
    .prepare("PRAGMA table_info(ai_provider_profiles)")
    .all();
  const expectedProfileColumns =
    expectedVersion === 2
      ? [
          "profile_id",
          "kind",
          "display_name",
          "normalized_display_name",
          "protocol",
          "model_id",
          "endpoint",
          "secret_ref",
          "created_at_ms",
          "updated_at_ms",
          "revision",
        ]
      : [
          "profile_id",
          "kind",
          "configuration_name",
          "protocol",
          "model_id",
          "endpoint",
          "secret_ref",
          "created_at_ms",
          "updated_at_ms",
          "revision",
        ];
  if (!hasExactColumns(profileColumns, expectedProfileColumns)) {
    throw new AudioStorageCorruptionError(
      `Audio database profile schema does not match v${expectedVersion}`,
    );
  }
  const requiredIndex =
    expectedVersion === 2
      ? "ai_provider_profiles_normalized_name"
      : "ai_provider_profiles_model_id_unique";
  const index = database
    .prepare("PRAGMA index_list(ai_provider_profiles)")
    .all()
    .find((row) => String(row.name) === requiredIndex);
  if (!index || Number(index.unique) !== 1) {
    throw new AudioStorageCorruptionError(
      `Audio database profile indexes do not match v${expectedVersion}`,
    );
  }
  const selectionForeignKey = database
    .prepare("PRAGMA foreign_key_list(ai_provider_selection)")
    .all()
    .find((row) => String(row.from) === "selected_profile_id");
  if (
    !selectionForeignKey ||
    String(selectionForeignKey.table) !== "ai_provider_profiles" ||
    String(selectionForeignKey.to) !== "profile_id" ||
    String(selectionForeignKey.on_delete).toUpperCase() !== "SET NULL"
  ) {
    throw new AudioStorageCorruptionError(
      `Audio database profile selection does not match v${expectedVersion}`,
    );
  }
  if (expectedVersion >= 3) assertSecretCleanupSchema(database);
}

function assertSecretCleanupSchema(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(ai_secret_cleanup_queue)")
    .all();
  if (
    !hasExactColumns(columns, [
      "secret_ref",
      "operation",
      "state",
      "created_at_ms",
      "updated_at_ms",
      "error_code",
    ]) ||
    Number(columns.find((row) => row.name === "secret_ref")?.pk) !== 1
  ) {
    throw new AudioStorageCorruptionError(
      "Audio database secret cleanup schema does not match v3",
    );
  }
}

function hasExactColumns(
  rows: Array<Record<string, unknown>>,
  expected: string[],
): boolean {
  const actual = new Set(rows.map((row) => String(row.name)));
  return (
    actual.size === expected.length &&
    expected.every((name) => actual.has(name))
  );
}

function assertIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || String(rows[0]?.quick_check) !== "ok") {
    throw new AudioStorageCorruptionError(
      "Audio database integrity check failed",
    );
  }
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new AudioStorageCorruptionError(`SQLite PRAGMA ${pragma} is invalid`);
  }
  return Number(value);
}
