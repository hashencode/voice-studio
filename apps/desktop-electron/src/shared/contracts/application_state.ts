import { z } from "zod";

import { desktopProtocolVersion } from "./ipc";

export const shellSectionSchema = z.enum([
  "library",
  "tasks",
  "companion",
  "settings",
]);

export const bootstrapActionSchema = z.literal("recheck");

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

export const activityItemSchema = z
  .object({
    id: z.string().min(1).max(260),
    kind: z.enum(["capture_completed", "capture_partial", "capture_failed"]),
    captureSessionId: z.string().min(1).max(128),
    createdAt: z.number().int().nonnegative(),
    title: z.string().min(1).max(80),
    severity: z.enum(["info", "warning"]),
    read: z.boolean(),
    resolved: z.boolean(),
    detailTarget: z.literal("capture-details"),
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
    activity: z.array(activityItemSchema).max(20).optional(),
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

export type ShellSection = z.infer<typeof shellSectionSchema>;
export type BootstrapAction = z.infer<typeof bootstrapActionSchema>;
export type ApplicationSnapshot = z.infer<typeof applicationSnapshotSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
