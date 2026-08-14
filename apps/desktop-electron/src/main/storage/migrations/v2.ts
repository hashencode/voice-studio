import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV1ToV2(database: DatabaseSync): void {
  database.exec(
    "ALTER TABLE processing_jobs ADD COLUMN cancel_requested_at_ms INTEGER",
  );
}
