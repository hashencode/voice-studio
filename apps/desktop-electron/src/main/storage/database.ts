import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertElectronProfilePaths,
  type ElectronProfilePaths,
} from "../profile/electron_profile";
import {
  createSchemaV1,
  ELECTRON_APPLICATION_ID,
  ELECTRON_SCHEMA_VERSION,
  REQUIRED_SCHEMA_TABLES,
} from "./schema";

export { ELECTRON_APPLICATION_ID, ELECTRON_SCHEMA_VERSION } from "./schema";

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class StorageCorruptionError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageCorruptionError";
  }
}

export class UnsupportedSchemaVersionError extends StorageError {
  constructor(version: number) {
    super(`Electron database schema ${version} is newer than supported v1`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export function openElectronProfileDatabase(
  profile: ElectronProfilePaths,
): DatabaseSync {
  assertElectronProfilePaths(profile);
  return openElectronDatabase(profile.databasePath);
}

export function openElectronDatabase(databasePath: string): DatabaseSync {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(resolvedPath);
    configure(database);
    assertIntegrity(database);
    migrate(database);
    validateSchema(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original open or validation error.
    }
    if (error instanceof StorageError) throw error;
    throw new StorageCorruptionError(
      "Electron database could not be opened or validated",
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
      // The original error is the transaction's durable failure signal.
    }
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

function migrate(database: DatabaseSync): void {
  const version = pragmaNumber(database, "user_version");
  const applicationId = pragmaNumber(database, "application_id");
  if (version > ELECTRON_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version);
  }
  if (applicationId !== 0 && applicationId !== ELECTRON_APPLICATION_ID) {
    throw new StorageCorruptionError(
      "Database at the Electron profile path has a foreign application id",
    );
  }
  if (version === 0) {
    withTransaction(database, () => {
      createSchemaV1(database);
      database.exec(`PRAGMA application_id = ${ELECTRON_APPLICATION_ID}`);
      database.exec(`PRAGMA user_version = ${ELECTRON_SCHEMA_VERSION}`);
    });
  }
}

function validateSchema(database: DatabaseSync): void {
  if (pragmaNumber(database, "application_id") !== ELECTRON_APPLICATION_ID) {
    throw new StorageCorruptionError("Electron database identity is missing");
  }
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  const missing = REQUIRED_SCHEMA_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new StorageCorruptionError(
      `Electron database is missing schema tables: ${missing.join(", ")}`,
    );
  }
  const foreignKeyViolations = database
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (foreignKeyViolations.length > 0) {
    throw new StorageCorruptionError(
      "Electron database has foreign-key damage",
    );
  }
}

function assertIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || String(rows[0]?.quick_check) !== "ok") {
    throw new StorageCorruptionError(
      "Electron database integrity check failed",
    );
  }
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new StorageCorruptionError(`SQLite PRAGMA ${pragma} is invalid`);
  }
  return Number(value);
}
