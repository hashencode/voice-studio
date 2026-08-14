import { z } from "zod";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const secureImportLimits = Object.freeze({
  maximumSourceBytes: 4 * 1024 * 1024 * 1024,
  maximumMinimumFreeBytes: 1024 * 1024 * 1024 * 1024,
  maximumDurationMs: 4 * 60 * 60 * 1_000,
  maximumPathBytes: 4_096,
});

export const secureImportReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    normalizedPath: z.string().min(1).max(4096),
    sourceSizeBytes: z.number().int().positive(),
    normalizedSizeBytes: z.number().int().min(45),
    sourceSha256: sha256Schema,
    normalizedSha256: sha256Schema,
    mediaType: z.literal("audio"),
    durationMs: z.number().int().positive(),
    sampleRate: z.literal(16_000),
    channels: z.literal(1),
    encoding: z.literal("pcm_s16le_wav"),
  })
  .strict();

export const secureImportRequestSchema = z
  .object({
    sourcePath: z.string().min(1).max(secureImportLimits.maximumPathBytes),
    destinationRoot: z.string().min(1).max(secureImportLimits.maximumPathBytes),
    destinationId: z.string().regex(/^meeting-[a-zA-Z0-9-]{12,120}$/),
    expectedSourceSha256: sha256Schema.optional(),
    maxSourceBytes: z
      .number()
      .int()
      .positive()
      .max(secureImportLimits.maximumSourceBytes),
    minimumFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(secureImportLimits.maximumMinimumFreeBytes),
    temporaryStorageMultiplier: z.number().min(1).max(8),
    maxDurationMs: z
      .number()
      .int()
      .positive()
      .max(secureImportLimits.maximumDurationMs),
  })
  .strict();

export const processingTaskStateSchema = z.enum([
  "queued",
  "running",
  "canceling",
  "canceled",
  "interrupted",
  "completed",
  "failed",
]);

export const processingTaskPhaseSchema = z.enum(["asr", "diarization"]);

export const processingTaskSchema = z
  .object({
    id: z.number().int().positive(),
    meetingId: z.number().int().positive(),
    displayName: z.string().min(1).max(256),
    state: processingTaskStateSchema,
    phase: processingTaskPhaseSchema,
    progressFraction: z.number().min(0).max(1),
    attempt: z.number().int().nonnegative(),
    errorCode: z.string().nullable(),
  })
  .strict();

export type SecureImportRequest = z.infer<typeof secureImportRequestSchema>;
export type SecureImportReceipt = z.infer<typeof secureImportReceiptSchema>;
export type ProcessingTask = z.infer<typeof processingTaskSchema>;
