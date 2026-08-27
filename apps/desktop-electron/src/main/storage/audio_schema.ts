import type { DatabaseSync } from "node:sqlite";

import { createAudioCoreSchema } from "./audio_schema_fragments/v1";
import { addAudioWorkspaceSchema } from "./audio_schema_fragments/v5";
import { addAudioWorkspaceIntegritySchema } from "./audio_schema_fragments/v6";
import { addCaptureSchema } from "./audio_schema_fragments/v7";
import { addCaptionSchema } from "./audio_schema_fragments/v8";
import {
  addAudioAiSchema,
  addAudioAiSchemaV1,
  addAudioAiSchemaV2,
} from "./audio_schema_fragments/v9";
import { addCompanionSchema } from "./audio_schema_fragments/v10";

export const AUDIO_SCHEMA_VERSION = 3;
export const AUDIO_APPLICATION_ID = 0x56324155;

const REQUIRED_AUDIO_BASE_TABLES = [
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

export const REQUIRED_AUDIO_SCHEMA_TABLES_V1 = [
  ...REQUIRED_AUDIO_BASE_TABLES,
  "ai_provider_settings",
] as const;

export const REQUIRED_AUDIO_SCHEMA_TABLES_V2 = [
  ...REQUIRED_AUDIO_BASE_TABLES,
  "ai_provider_profiles",
  "ai_provider_selection",
] as const;

export const REQUIRED_AUDIO_SCHEMA_TABLES = [
  ...REQUIRED_AUDIO_SCHEMA_TABLES_V2,
  "ai_secret_cleanup_queue",
] as const;

/** Builds the legacy schema used by the v1 migration and its fixtures. */
export function createAudioSchemaV1(database: DatabaseSync): void {
  createAudioCoreSchema(database);
  addAudioWorkspaceSchema(database);
  addAudioWorkspaceIntegritySchema(database);
  addCaptureSchema(database);
  addCaptionSchema(database);
  addAudioAiSchemaV1(database);
  addCompanionSchema(database);
}

/** Builds the current fresh Audio schema. No historical rows are read. */
export function createAudioSchemaV2(database: DatabaseSync): void {
  createAudioCoreSchema(database);
  addAudioWorkspaceSchema(database);
  addAudioWorkspaceIntegritySchema(database);
  addCaptureSchema(database);
  addCaptionSchema(database);
  addAudioAiSchemaV2(database);
  addCompanionSchema(database);
}

/** Builds the current fresh Audio schema. No historical rows are read. */
export function createAudioSchemaV3(database: DatabaseSync): void {
  createAudioCoreSchema(database);
  addAudioWorkspaceSchema(database);
  addAudioWorkspaceIntegritySchema(database);
  addCaptureSchema(database);
  addCaptionSchema(database);
  addAudioAiSchema(database);
  addCompanionSchema(database);
}
