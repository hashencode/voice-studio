import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AUDIO_APPLICATION_ID,
  AUDIO_SCHEMA_VERSION,
  createAudioSchemaV1,
  REQUIRED_AUDIO_SCHEMA_TABLES,
} from "./audio_schema";

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

export function openAudioDatabase(databasePath: string): DatabaseSync {
  const resolvedPath =
    databasePath === ":memory:" ? databasePath : resolve(databasePath);
  const existing =
    resolvedPath !== ":memory:" &&
    existsSync(resolvedPath) &&
    statSync(resolvedPath).size > 0;
  if (existing) inspectExistingDatabase(resolvedPath);
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
        createAudioSchemaV1(database);
        database.exec(`PRAGMA application_id = ${AUDIO_APPLICATION_ID}`);
        database.exec(`PRAGMA user_version = ${AUDIO_SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    validateAudioSchema(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original failure.
    }
    if (error instanceof AudioStorageError) throw error;
    throw new AudioStorageCorruptionError(
      "Audio database could not be created or validated",
      { cause: error },
    );
  }
}

function inspectExistingDatabase(path: string): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    assertIntegrity(database);
    const applicationId = pragmaNumber(database, "application_id");
    const version = pragmaNumber(database, "user_version");
    if (
      applicationId !== AUDIO_APPLICATION_ID ||
      version !== AUDIO_SCHEMA_VERSION
    ) {
      throw new AudioStorageCompatibilityError(
        "Existing database is not the fresh Audio v1 store; migration and compatibility reads are unsupported",
      );
    }
    validateAudioSchema(database);
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

function configure(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
}

function validateAudioSchema(database: DatabaseSync): void {
  if (pragmaNumber(database, "application_id") !== AUDIO_APPLICATION_ID) {
    throw new AudioStorageCompatibilityError(
      "Audio database application identity does not match Audio v1",
    );
  }
  if (pragmaNumber(database, "user_version") !== AUDIO_SCHEMA_VERSION) {
    throw new AudioStorageCompatibilityError(
      "Audio database schema version does not match Audio v1",
    );
  }
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  const missing = REQUIRED_AUDIO_SCHEMA_TABLES.filter(
    (table) => !tables.has(table),
  );
  if (missing.length > 0) {
    throw new AudioStorageCorruptionError(
      `Audio database is missing schema tables: ${missing.join(", ")}`,
    );
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new AudioStorageCorruptionError(
      "Audio database has foreign-key damage",
    );
  }
  assertIntegrity(database);
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
