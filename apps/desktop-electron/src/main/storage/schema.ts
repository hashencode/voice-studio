export const ELECTRON_SCHEMA_VERSION = 7;
export const ELECTRON_APPLICATION_ID = 0x56325445;
export { createSchemaV1 } from "./migrations/v1";
export { migrateSchemaV1ToV2 } from "./migrations/v2";
export { migrateSchemaV2ToV3 } from "./migrations/v3";
export { migrateSchemaV3ToV4 } from "./migrations/v4";
export { migrateSchemaV4ToV5 } from "./migrations/v5";
export { migrateSchemaV5ToV6 } from "./migrations/v6";
export { migrateSchemaV6ToV7 } from "./migrations/v7";

export const REQUIRED_SCHEMA_TABLES = [
  "meetings",
  "processing_jobs",
  "meeting_notes",
  "durable_receipts",
  "result_publications",
  "media_authorities",
  "meeting_generations",
  "meeting_speakers",
  "transcript_segments",
  "workspace_heads",
  "transcript_revisions",
  "capture_sessions",
  "capture_command_receipts",
  "capture_tracks",
  "capture_chunks",
  "capture_events",
] as const;
