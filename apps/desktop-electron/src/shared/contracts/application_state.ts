import { z } from "zod";

import { desktopProtocolVersion } from "./ipc";
import { captureAudioActivitySchema } from "./capture";

export const shellSectionSchema = z.enum([
  "library",
  "tasks",
  "companion",
  "settings",
]);

export const bootstrapActionSchema = z.enum(["recheck", "reset-profile"]);

const profileStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("initializing") }).strict(),
  z.object({ phase: z.literal("reconciling") }).strict(),
  z
    .object({
      phase: z.literal("ready"),
      legacyDatabaseArchived: z.boolean(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("blocked"),
      code: z.enum([
        "filesystem_unavailable",
        "legacy_archive_failed",
        "insufficient_space",
        "path_escape",
        "schema_invalid",
      ]),
      message: z.string().min(1).max(512),
      repairable: z.literal(true),
    })
    .strict(),
]);

const libraryStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("loading") }).strict(),
  z.object({ phase: z.literal("empty") }).strict(),
  z
    .object({
      phase: z.literal("ready"),
      audioCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("error"),
      message: z.string().min(1).max(512),
      retryable: z.boolean(),
    })
    .strict(),
]);

const reconciliationItemSchema = z
  .object({
    kind: z.enum(["processing", "capture", "staging", "ai", "transfer"]),
    identity: z.string().min(1).max(256),
    state: z.enum(["interrupted", "repairable"]),
    requiresExplicitAction: z.literal(true),
  })
  .strict();

const captureStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }).strict(),
  z
    .object({
      phase: z.enum([
        "preflight",
        "preparing",
        "recording",
        "paused",
        "finalizing",
        "completed",
        "recovery",
        "partial_capture",
        "failed",
      ]),
      sessionId: z.string().min(1).max(128),
      title: z.string().min(1).max(256),
      elapsedMs: z.number().int().nonnegative(),
      audioActivity: captureAudioActivitySchema.optional(),
      message: z.string().min(1).max(512).optional(),
      captureMode: z
        .enum(["dual_track", "microphone_only", "system_audio_only"])
        .optional(),
      systemAudioHealthy: z.boolean().optional(),
      microphoneHealthy: z.boolean().optional(),
      partialCapture: z.boolean().optional(),
      gapCount: z.number().int().nonnegative().max(100_000).optional(),
      interruptionReason: z.string().min(1).max(240).nullable().optional(),
    })
    .strict(),
]);

export const captureLibraryProjectionFailureCodeSchema = z.enum([
  "invalid_authority",
  "commit_failed",
  "projection_unavailable",
]);

export const captureLibraryProjectionStateSchema = z.discriminatedUnion(
  "phase",
  [
    z.object({ phase: z.literal("idle") }).strict(),
    z
      .object({
        phase: z.literal("registering"),
        sessionId: z.string().trim().min(1).max(128),
        intentId: z.string().trim().min(1).max(128),
      })
      .strict(),
    z
      .object({
        phase: z.literal("registered"),
        sessionId: z.string().trim().min(1).max(128),
        intentId: z.string().trim().min(1).max(128),
        audioId: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        phase: z.literal("failed"),
        sessionId: z.string().trim().min(1).max(128),
        intentId: z.string().trim().min(1).max(128),
        code: captureLibraryProjectionFailureCodeSchema,
        message: z.string().min(1).max(160),
      })
      .strict(),
  ],
);

export const applicationFailureKindSchema = z.enum([
  "processing_runtime_unavailable",
  "capture_runtime_unavailable",
  "startup_reconciliation_failed",
]);

export const settingsSectionSchema = z.enum([
  "general",
  "recording",
  "local-models",
  "cloud-models",
]);
export const applicationFailureSettingsTargetSchema = settingsSectionSchema;

export const applicationActivityLimit = 30;

export const activityItemSchema = z
  .object({
    id: z.string().min(1).max(260),
    kind: applicationFailureKindSchema,
    safeSummary: z.string().trim().min(1).max(160),
    occurrenceCount: z.number().int().positive(),
    unread: z.boolean(),
    settingsTarget: applicationFailureSettingsTargetSchema.nullable(),
    lastOccurredAt: z.number().int().nonnegative(),
  })
  .strict();

export const applicationSnapshotSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    revision: z.number().int().nonnegative(),
    navigation: z.object({ section: shellSectionSchema }).strict(),
    profile: profileStateSchema,
    connectivity: z.enum(["online", "offline"]),
    capability: z.discriminatedUnion("processing", [
      z.object({ processing: z.literal("available") }).strict(),
      z
        .object({
          processing: z.literal("unavailable"),
          reason: z.string().min(1).max(512),
        })
        .strict(),
    ]),
    library: libraryStateSchema,
    reconciliation: z.array(reconciliationItemSchema).max(256),
    capture: captureStateSchema,
    libraryProjection: captureLibraryProjectionStateSchema.default({
      phase: "idle",
    }),
    activity: z
      .array(activityItemSchema)
      .max(applicationActivityLimit)
      .optional(),
  })
  .strict();

export const getApplicationSnapshotRequestSchema = z
  .object({ expectedProtocolVersion: z.literal(desktopProtocolVersion) })
  .strict();
export const navigateRequestSchema = z
  .object({ section: shellSectionSchema })
  .strict();
export const bootstrapActionRequestSchema = z
  .object({ action: bootstrapActionSchema })
  .strict();
export const markActivityReadRequestSchema = z
  .object({ activityId: z.string().min(1).max(260) })
  .strict();
export const markAllActivityReadRequestSchema = z.object({}).strict();
export const captureLibraryProjectionRetryRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    intentId: z.string().trim().min(1).max(128),
  })
  .strict();

export type ShellSection = z.infer<typeof shellSectionSchema>;
export type BootstrapAction = z.infer<typeof bootstrapActionSchema>;
export type ApplicationSnapshot = z.output<typeof applicationSnapshotSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ApplicationFailureKind = z.infer<
  typeof applicationFailureKindSchema
>;
export type ApplicationFailureSettingsTarget = z.infer<
  typeof applicationFailureSettingsTargetSchema
>;
export type SettingsSection = z.infer<typeof settingsSectionSchema>;
export type CaptureLibraryProjectionFailureCode = z.infer<
  typeof captureLibraryProjectionFailureCodeSchema
>;
export type CaptureLibraryProjectionRetryRequest = z.infer<
  typeof captureLibraryProjectionRetryRequestSchema
>;
