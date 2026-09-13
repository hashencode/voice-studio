import { z } from "zod";

import { sha256Schema } from "./import_processing";

export const captureSessionIdSchema = z
  .string()
  .regex(/^session-[a-zA-Z0-9-]{12,120}$/);
export const captureTitleSchema = z.string().trim().min(1).max(256);
export const captureAudioActivitySchema = z.number().finite().min(0).max(1);

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
    sessionId: captureSessionIdSchema,
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
export const captureRuntimeSnapshotSchema = captureSnapshotSchema.extend({
  audioActivity: captureAudioActivitySchema,
});
export const captureRecoveryCapabilitySchema = z.enum([
  "restorable",
  "discard-only",
  "preserve-only",
]);
export const captureRecoveryReasonSchema = z.enum([
  "no-audio-data",
  "unfinished-audio-data",
  "recovery-metadata-damaged",
  "audio-integrity-failed",
  "finalization-in-progress",
  "currently-unverifiable",
]);
export const captureRecoveryItemSchema = captureSnapshotSchema
  .extend({
    title: captureTitleSchema,
    capability: captureRecoveryCapabilitySchema,
    reason: captureRecoveryReasonSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    if ((item.capability === "restorable") !== (item.reason === null)) {
      context.addIssue({
        code: "custom",
        message: "recovery capability and reason are inconsistent",
        path: ["reason"],
      });
    }
  });

export const suggestCaptureTitleRequestSchema = z.object({}).strict();
export const suggestCaptureTitleResponseSchema = z
  .object({ title: captureTitleSchema })
  .strict();
export const renameCaptureSessionRequestSchema = z
  .object({
    sessionId: captureSessionIdSchema,
    title: captureTitleSchema,
  })
  .strict();

export const captureStartCommandSchema = z
  .object({
    sessionId: captureSessionIdSchema,
    title: captureTitleSchema,
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
    sessionId: captureSessionIdSchema,
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
    title: captureTitleSchema,
    refreshSuggestedTitle: z.boolean().optional(),
    microphoneDeviceId: z.string().min(1).max(512).optional(),
    captionEnabled: z.boolean(),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();
export const captureControlRequestSchema = z
  .object({
    action: z.enum(["pause", "resume", "stop"]),
    sessionId: captureSessionIdSchema,
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();
export const captureRecoveryActionRequestSchema = z
  .object({
    action: z.enum(["keep", "discard"]),
    intent: z.enum(["user-decision", "automatic-discard-only-cleanup"]),
    sessionIds: z.array(captureSessionIdSchema).min(1).max(256),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.sessionIds).size !== request.sessionIds.length) {
      context.addIssue({
        code: "custom",
        message: "capture recovery targets must be unique",
        path: ["sessionIds"],
      });
    }
    if (
      request.intent === "automatic-discard-only-cleanup" &&
      request.action !== "discard"
    ) {
      context.addIssue({
        code: "custom",
        message: "automatic recovery cleanup can only discard",
        path: ["action"],
      });
    }
  });
export const captureRecoveryOutcomeSchema = z
  .object({
    sessionId: captureSessionIdSchema,
    action: z.enum(["keep", "discard"]),
    result: z.enum(["kept", "discarded", "preserved", "conflict", "failed"]),
    completionCertainty: z.enum(["completed", "not-completed", "unknown"]),
    audioDurability: z.enum([
      "durable",
      "discarded",
      "preserved",
      "unchanged",
      "unknown",
    ]),
    transcriptionHandoff: z.enum([
      "not-requested",
      "pending",
      "completed",
      "failed",
    ]),
    capture: captureSnapshotSchema.nullable(),
  })
  .strict();
export const captureRecoveryActionResponseSchema = z
  .object({
    outcomes: z.array(captureRecoveryOutcomeSchema).max(256),
    recoveries: z.array(captureRecoveryItemSchema).max(256),
  })
  .strict();
export const captureRecoveryListRequestSchema = z.object({}).strict();

export const microphoneTestStateSchema = z.enum([
  "running",
  "finished",
  "failed",
  "cancelled",
]);
export const microphoneTestReasonSchema = z.enum([
  "detected",
  "no-audio-frames",
  "no-sound-observed",
  "permission-denied",
  "device-unavailable",
  "device-open-failed",
  "unsupported-format",
  "native-helper-failed",
  "snapshot-failed",
]);
export const microphoneTestDiagnosticSchema = z.enum([
  "permission_denied",
  "selected_uid_unavailable",
  "selected_device_inactive",
  "audio_unit_selection_failed",
  "initial_engine_start_failed",
  "recovery_restart_failed",
  "unsupported_format",
]);
export const microphoneTestSnapshotSchema = z
  .object({
    testId: z.string().regex(/^mic-test-[a-zA-Z0-9-]{12,120}$/),
    state: microphoneTestStateSchema,
    reason: microphoneTestReasonSchema.optional(),
    diagnostic: microphoneTestDiagnosticSchema.optional(),
    elapsedMs: z.number().int().nonnegative().safe(),
    normalizedRMS: z.number().min(0).max(1),
    normalizedPeak: z.number().min(0).max(1),
    observedFrames: z.number().int().nonnegative().safe(),
    observedSound: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const reason = snapshot.reason;
    const valid =
      (snapshot.state === "running" && reason === undefined) ||
      (snapshot.state === "cancelled" && reason === undefined) ||
      (snapshot.state === "finished" &&
        reason !== undefined &&
        ["detected", "no-audio-frames", "no-sound-observed"].includes(
          reason,
        )) ||
      (snapshot.state === "failed" &&
        reason !== undefined &&
        !["detected", "no-audio-frames", "no-sound-observed"].includes(reason));
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "microphone test state and reason are inconsistent",
        path: ["reason"],
      });
    }
    if (snapshot.diagnostic !== undefined && snapshot.state !== "failed") {
      context.addIssue({
        code: "custom",
        message: "microphone test diagnostic is only valid for failures",
        path: ["diagnostic"],
      });
    }
  });
export const microphoneTestStartRequestSchema = z
  .object({
    microphoneDeviceId: z.string().min(1).max(512).optional(),
  })
  .strict();
export const microphoneTestControlRequestSchema = z
  .object({
    testId: z.string().regex(/^mic-test-[a-zA-Z0-9-]{12,120}$/),
  })
  .strict();
export const microphoneSettingsOpenRequestSchema = z.object({}).strict();
export const microphoneSettingsOpenResultSchema = z
  .object({ state: z.enum(["opened", "failed"]) })
  .strict();

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
export type CaptureRuntimeSnapshot = z.infer<
  typeof captureRuntimeSnapshotSchema
>;
export type CaptureRecoveryItem = z.infer<typeof captureRecoveryItemSchema>;
export type CaptureRecoveryCapability = z.infer<
  typeof captureRecoveryCapabilitySchema
>;
export type CaptureRecoveryReason = z.infer<typeof captureRecoveryReasonSchema>;
export type CaptureRecoveryOutcome = z.infer<
  typeof captureRecoveryOutcomeSchema
>;
export type CaptureRecoveryActionRequest = z.infer<
  typeof captureRecoveryActionRequestSchema
>;
export type CaptureRecoveryActionResponse = z.infer<
  typeof captureRecoveryActionResponseSchema
>;
export type SuggestCaptureTitleResponse = z.infer<
  typeof suggestCaptureTitleResponseSchema
>;
export type RenameCaptureSessionRequest = z.infer<
  typeof renameCaptureSessionRequestSchema
>;
export type CaptureStartCommand = z.infer<typeof captureStartCommandSchema>;
export type CaptureControlCommand = z.infer<typeof captureControlCommandSchema>;
export type CaptureControlRequest = z.infer<typeof captureControlRequestSchema>;
export type MicrophoneTestSnapshot = z.infer<
  typeof microphoneTestSnapshotSchema
>;
