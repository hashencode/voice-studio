export const ELECTRON_SCHEMA_VERSION = 1;
export const ELECTRON_APPLICATION_ID = 0x56325445;
export { createSchemaV1 } from "./migrations/v1";

export const REQUIRED_SCHEMA_TABLES = [
  "meetings",
  "processing_jobs",
  "meeting_notes",
  "durable_receipts",
  "result_publications",
] as const;
