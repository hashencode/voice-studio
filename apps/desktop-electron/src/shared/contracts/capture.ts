import { z } from "zod";

import { sha256Schema } from "./import_processing";

export const captureSessionStateSchema = z.enum([
  "idle",
  "preflight",
  "preparing",
  "recording",
  "paused",
  "finalizing",
  "completed",
  "recoverable",
  "partial_capture",
  "failed",
]);
export const captureModeSchema = z.enum([
  "dual_track",
  "microphone_only",
  "system_audio_only",
]);
export const capturePermissionSchema = z.enum([
  "not_determined",
  "granted",
  "denied",
  "restricted",
  "revoked",
  "unavailable",
]);
export const captureDeviceSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    isDefault: z.boolean(),
  })
  .strict();
export const capturePreflightSchema = z
  .object({
    minimumMacosVersion: z.string().min(1).max(32),
    systemAudioMinimumMacosVersion: z.string().min(1).max(32),
    captureMode: captureModeSchema,
    systemAudioPermission: capturePermissionSchema,
    microphonePermission: capturePermissionSchema,
    microphones: z.array(captureDeviceSchema).max(64),
    availableBytes: z.number().int().nonnegative().safe(),
    requiredBytes: z.number().int().nonnegative().safe(),
    captionModelAvailable: z.boolean(),
    canStart: z.boolean(),
    blockingReasons: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();
export const captureSnapshotSchema = z
  .object({
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    state: captureSessionStateSchema.exclude(["idle", "preflight"]),
    captureMode: captureModeSchema,
    captureTimelineMs: z.number().int().nonnegative().safe(),
    systemAudioHealthy: z.boolean(),
    microphoneHealthy: z.boolean(),
    partialCapture: z.boolean(),
    finalizedChunkCount: z.number().int().nonnegative().max(100_000),
    eventCount: z.number().int().nonnegative().max(100_000),
    gapCount: z.number().int().nonnegative().max(100_000),
    interruptionReason: z.string().min(1).max(240).nullable(),
    recordingSha256: sha256Schema.nullable(),
    journalSha256: sha256Schema.nullable().optional(),
    invalidFinalizedChunks: z
      .number()
      .int()
      .nonnegative()
      .max(100_000)
      .optional(),
    quarantinedTailChunks: z
      .number()
      .int()
      .nonnegative()
      .max(100_000)
      .optional(),
  })
  .strict();

export const captureStartCommandSchema = z
  .object({
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    title: z.string().trim().min(1).max(256),
    idempotencyKey: z.string().min(1).max(160),
    minimumFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 ** 4),
    microphoneDeviceId: z.string().min(1).max(512).optional(),
    captionEnabled: z.boolean(),
  })
  .strict();
export const captureControlCommandSchema = z
  .object({
    action: z.enum(["pause", "resume", "stop"]),
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();

export const capturePreflightRequestSchema = z
  .object({
    requestPermissions: z.boolean(),
    captionEnabled: z.boolean(),
  })
  .strict();
export const captureStartRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    microphoneDeviceId: z.string().min(1).max(512).optional(),
    captionEnabled: z.boolean(),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();
export const captureControlRequestSchema = z
  .object({
    action: z.enum(["pause", "resume", "stop"]),
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();
export const captureRecoveryActionRequestSchema = z
  .object({
    action: z.enum(["keep", "discard"]),
    sessionId: z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();
export const captureRecoveryListRequestSchema = z.object({}).strict();

export const desktopCaptureParitySchema = z
  .object({
    schemaVersion: z.literal(1),
    authority: z.string().min(1),
    protocol: z.literal("voice2text-macos-helper/v1"),
    captureSchema: z.literal("desktop-capture-session/v1"),
    states: z.array(captureSessionStateSchema),
    commands: z.array(z.string().min(1)),
    preflightBranches: z
      .object({
        permissionDenied: z.string(),
        unsupportedRuntime: z.string(),
        missingDevice: z.string(),
        lowDisk: z.string(),
        captionUnavailable: z.string(),
      })
      .strict(),
    tracks: z.tuple([z.literal("system_audio"), z.literal("microphone")]),
    healthyTrackFailure: z
      .object({
        state: z.literal("partial_capture"),
        requiresGap: z.literal(true),
        preservesHealthyTrack: z.literal(true),
      })
      .strict(),
    journal: z
      .object({
        maximumChunks: z.literal(100_000),
        maximumEvents: z.literal(100_000),
        chunkDurationMs: z.literal(5_000),
        hash: z.literal("sha256"),
        corruptTailDisposition: z.literal("quarantine"),
      })
      .strict(),
    lifecycle: z
      .object({
        rendererLossKeepsCapture: z.literal(true),
        sleepPauses: z.literal(true),
        wakeRequiresExplicitResume: z.literal(true),
        quitDefault: z.literal("continue_recording"),
        quitCommitAction: z.literal("stop_finalize_quit"),
        quitOffersDiscard: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type CapturePreflight = z.infer<typeof capturePreflightSchema>;
export type CaptureSnapshot = z.infer<typeof captureSnapshotSchema>;
export type CaptureStartCommand = z.infer<typeof captureStartCommandSchema>;
export type CaptureControlCommand = z.infer<typeof captureControlCommandSchema>;
export type CaptureControlRequest = z.infer<typeof captureControlRequestSchema>;
