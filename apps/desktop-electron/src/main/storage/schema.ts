export const ELECTRON_SCHEMA_VERSION = 10;
export const ELECTRON_APPLICATION_ID = 0x56325445;
export { createSchemaV1 } from "./migrations/v1";
export { migrateSchemaV1ToV2 } from "./migrations/v2";
export { migrateSchemaV2ToV3 } from "./migrations/v3";
export { migrateSchemaV3ToV4 } from "./migrations/v4";
export { migrateSchemaV4ToV5 } from "./migrations/v5";
export { migrateSchemaV5ToV6 } from "./migrations/v6";
export { migrateSchemaV6ToV7 } from "./migrations/v7";
export { migrateSchemaV7ToV8 } from "./migrations/v8";
export { migrateSchemaV8ToV9 } from "./migrations/v9";
export { migrateSchemaV9ToV10 } from "./migrations/v10";

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
  "caption_sessions",
  "caption_utterances",
  "caption_formal_handoffs",
  "caption_formal_preparations",
  "caption_formal_attempts",
  "caption_command_receipts",
  "ai_provider_settings",
  "ai_consents",
  "ai_jobs",
  "ai_notes",
  "ai_insights",
  "ai_evidence_links",
  "ai_command_receipts",
  "companion_settings",
  "companion_peers",
  "companion_transfers",
  "companion_transfer_chunks",
  "companion_command_receipts",
] as const;
