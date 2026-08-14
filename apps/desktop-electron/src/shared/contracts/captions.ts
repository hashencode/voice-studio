import { z } from "zod";

const captionSessionIdSchema = z
  .string()
  .regex(/^session-[a-zA-Z0-9-]{12,120}$/);
const captionErrorCodeSchema = z.string().min(1).max(128).nullable();

export const captionDraftStateSchema = z.enum([
  "preparing",
  "running",
  "paused",
  "flushing",
  "flushed",
  "degraded",
]);

export const captionFormalStateSchema = z.enum([
  "not_queued",
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const captionDisplayAuthoritySchema = z.enum([
  "none",
  "live_draft",
  "formal",
  "manual",
  "revision_required",
]);

export const captionUtteranceSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    startMs: z.number().int().nonnegative().safe(),
    endMs: z.number().int().positive().safe(),
    text: z.string().trim().min(1).max(4_000),
    language: z.string().trim().min(1).max(32),
  })
  .strict()
  .refine((utterance) => utterance.endMs > utterance.startMs, {
    message: "caption utterance end must follow start",
  });

export const captionSnapshotSchema = z
  .object({
    sessionId: captionSessionIdSchema,
    revision: z.number().int().nonnegative().safe(),
    draft: z
      .object({
        generationId: z.number().int().positive().safe(),
        attempt: z.number().int().positive().safe(),
        state: captionDraftStateSchema,
        utterances: z.array(captionUtteranceSchema).max(128),
        hasEarlierUtterances: z.boolean(),
        backlogBytes: z.number().int().nonnegative().safe(),
        errorCode: captionErrorCodeSchema,
      })
      .strict()
      .nullable(),
    formal: z
      .object({
        generationId: z.number().int().positive().safe().nullable(),
        attempt: z.number().int().nonnegative().safe(),
        state: captionFormalStateSchema,
        errorCode: captionErrorCodeSchema,
      })
      .strict(),
    displayAuthority: captionDisplayAuthoritySchema,
  })
  .strict();

export const captionSnapshotRequestSchema = z
  .object({ sessionId: captionSessionIdSchema })
  .strict();

export const captionFormalRetryRequestSchema = z
  .object({
    sessionId: captionSessionIdSchema,
    expectedAttempt: z.number().int().nonnegative().safe(),
    idempotencyKey: z.string().min(12).max(160),
  })
  .strict();

export type CaptionDraftState = z.infer<typeof captionDraftStateSchema>;
export type CaptionFormalState = z.infer<typeof captionFormalStateSchema>;
export type CaptionDisplayAuthority = z.infer<
  typeof captionDisplayAuthoritySchema
>;
export type CaptionUtterance = z.infer<typeof captionUtteranceSchema>;
export type CaptionSnapshot = z.infer<typeof captionSnapshotSchema>;
export type CaptionSnapshotRequest = z.infer<
  typeof captionSnapshotRequestSchema
>;
export type CaptionFormalRetryRequest = z.infer<
  typeof captionFormalRetryRequestSchema
>;
