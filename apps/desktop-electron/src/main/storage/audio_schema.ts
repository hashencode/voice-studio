import type { DatabaseSync } from "node:sqlite";

import { createAudioCoreSchema } from "./audio_schema_fragments/v1";
import { addAudioWorkspaceSchema } from "./audio_schema_fragments/v5";
import { addAudioWorkspaceIntegritySchema } from "./audio_schema_fragments/v6";
import { addCaptureSchema } from "./audio_schema_fragments/v7";
import { addCaptionSchema } from "./audio_schema_fragments/v8";
import { addAudioAiSchema } from "./audio_schema_fragments/v9";
import { addCompanionSchema } from "./audio_schema_fragments/v10";

export const AUDIO_SCHEMA_VERSION = 1;
export const AUDIO_APPLICATION_ID = 0x56324155;

export const REQUIRED_AUDIO_SCHEMA_TABLES = [
  "audio_items",
  "processing_jobs",
  "audio_notes",
  "durable_receipts",
  "result_publications",
  "media_authorities",
  "audio_generations",
  "audio_speakers",
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

/** Builds the only supported fresh Audio schema. No historical rows are read. */
export function createAudioSchemaV1(database: DatabaseSync): void {
  createAudioCoreSchema(database);
  addAudioWorkspaceSchema(database);
  addAudioWorkspaceIntegritySchema(database);
  addCaptureSchema(database);
  addCaptionSchema(database);
  addAudioAiSchema(database);
  addCompanionSchema(database);
}
