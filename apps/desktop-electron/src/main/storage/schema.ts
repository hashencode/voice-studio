export const ELECTRON_SCHEMA_VERSION = 4;
export const ELECTRON_APPLICATION_ID = 0x56325445;
export { createSchemaV1 } from "./migrations/v1";
export { migrateSchemaV1ToV2 } from "./migrations/v2";
export { migrateSchemaV2ToV3 } from "./migrations/v3";
export { migrateSchemaV3ToV4 } from "./migrations/v4";

export const REQUIRED_SCHEMA_TABLES = [
  "meetings",
  "processing_jobs",
  "meeting_notes",
  "durable_receipts",
  "result_publications",
  "media_authorities",
] as const;
