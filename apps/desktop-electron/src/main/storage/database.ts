import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertElectronProfilePaths,
  type ElectronProfilePaths,
} from "../profile/profile_paths";
import {
  createSchemaV1,
  ELECTRON_APPLICATION_ID,
  ELECTRON_SCHEMA_VERSION,
  migrateSchemaV1ToV2,
  migrateSchemaV2ToV3,
  migrateSchemaV3ToV4,
  migrateSchemaV4ToV5,
  migrateSchemaV5ToV6,
  migrateSchemaV6ToV7,
  migrateSchemaV7ToV8,
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
    super(
      `Electron database schema ${version} is newer than supported v${ELECTRON_SCHEMA_VERSION}`,
    );
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
  const resolvedPath =
    databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }
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
    if (process.env.VOICE2TEXT_PROCESSING_SMOKE_OUTPUT) {
      console.error(
        JSON.stringify({
          event: "electron-storage-open-failed",
          code:
            typeof (error as NodeJS.ErrnoException)?.code === "string"
              ? (error as NodeJS.ErrnoException).code
              : "UNKNOWN",
          message: storageDiagnostic(error),
        }),
      );
    }
    throw new StorageCorruptionError(
      "Electron database could not be opened or validated",
      { cause: error },
    );
  }
}

function storageDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:\/[^\s:'"]+)+/g, "<path>")
    .replaceAll(/[\r\n]/g, " ")
    .slice(0, 240);
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
  let version = pragmaNumber(database, "user_version");
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
      database.exec("PRAGMA user_version = 1");
    });
    version = 1;
  }
  if (version === 1) {
    withTransaction(database, () => {
      migrateSchemaV1ToV2(database);
      database.exec("PRAGMA user_version = 2");
    });
    version = 2;
  }
  if (version === 2) {
    withTransaction(database, () => {
      migrateSchemaV2ToV3(database);
      database.exec("PRAGMA user_version = 3");
    });
    version = 3;
  }
  if (version === 3) {
    withTransaction(database, () => {
      migrateSchemaV3ToV4(database);
      database.exec("PRAGMA user_version = 4");
    });
    version = 4;
  }
  if (version === 4) {
    withTransaction(database, () => {
      migrateSchemaV4ToV5(database);
      database.exec("PRAGMA user_version = 5");
    });
    version = 5;
  }
  if (version === 5) {
    withTransaction(database, () => {
      migrateSchemaV5ToV6(database);
      database.exec("PRAGMA user_version = 6");
    });
    version = 6;
  }
  if (version === 6) {
    withTransaction(database, () => {
      migrateSchemaV6ToV7(database);
      database.exec("PRAGMA user_version = 7");
    });
    version = 7;
  }
  if (version === 7) {
    withTransaction(database, () => {
      migrateSchemaV7ToV8(database);
      database.exec("PRAGMA user_version = 8");
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
