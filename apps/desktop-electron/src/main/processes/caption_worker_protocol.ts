import { createHash } from "node:crypto";

import { z } from "zod";

const sessionIdSchema = z.string().regex(/^session-[a-zA-Z0-9-]{12,120}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const alignedOffsetSchema = z.number().int().nonnegative().safe();

export const captionWorkerRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("openSession"),
      sessionId: sessionIdSchema,
      generationId: z.number().int().positive().safe(),
      spoolRelativePath: z.literal("caption/live-caption.pcmspool"),
      offsetBytes: alignedOffsetSchema.refine((value) => value % 3_200 === 0),
      firstSequence: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.enum(["poll", "flush"]),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({ schemaVersion: z.literal(1), type: z.literal("shutdown") })
    .strict(),
]);

const rawUtteranceSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("utterance"),
    sessionId: sessionIdSchema,
    generationId: z.number().int().positive().safe(),
    sequence: z.number().int().positive().safe(),
    startSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(24 * 60 * 60),
    endSeconds: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60),
    text: z.string().max(4_000),
    textSha256: sha256Schema,
    language: z.string().trim().min(1).max(32),
    event: z.string().max(128),
    offsetBytes: alignedOffsetSchema,
    modelSha256: sha256Schema,
    residentBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

const rawProgressBase = {
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  generationId: z.number().int().positive().safe(),
  offsetBytes: alignedOffsetSchema,
  nextSequence: z.number().int().positive().safe(),
  backlogBytes: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024)
    .safe()
    .optional(),
  residentBytes: z.number().int().nonnegative().safe().optional(),
};
const rawProgressSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...rawProgressBase,
      type: z.literal("sessionReady"),
      modelSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...rawProgressBase,
      type: z.enum(["pollComplete", "sessionComplete"]),
      modelSha256: sha256Schema.optional(),
    })
    .strict(),
]);

export const captionWorkerReadySchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("ready"),
    protocol: z.literal("sensevoice-live-caption-worker/v1"),
    processId: z.number().int().positive().safe(),
    modelLoadMs: z.number().finite().nonnegative(),
    residentBytes: z.number().int().nonnegative().safe(),
    effectiveConfig: z.record(z.string(), z.unknown()),
    publishesTokenPartials: z.literal(false),
  })
  .strict();

export const captionWorkerErrorSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("error"),
    code: z.string().min(1).max(128),
    message: z.string().max(256),
  })
  .strict();

export interface CaptionWorkerFence {
  sessionId: string;
  generationId: number;
  attempt: number;
  modelSha256: string;
}

export type AdaptedCaptionWorkerEvent =
  | {
      type: "utterance";
      sessionId: string;
      generationId: number;
      attempt: number;
      sequence: number;
      startMs: number;
      endMs: number;
      text: string;
      language: string;
      offsetBytes: number;
      modelSha256: string;
    }
  | {
      type: "silence";
      sessionId: string;
      generationId: number;
      attempt: number;
      sequence: number;
      startMs: number;
      endMs: number;
      offsetBytes: number;
      modelSha256: string;
    }
  | {
      type: "sessionReady" | "pollComplete" | "sessionComplete";
      sessionId: string;
      generationId: number;
      attempt: number;
      offsetBytes: number;
      nextSequence: number;
      backlogBytes: number;
    };

export function adaptCaptionWorkerEvent(
  raw: unknown,
  fence: CaptionWorkerFence,
): AdaptedCaptionWorkerEvent {
  const type = (raw as { type?: unknown } | null)?.type;
  const event =
    type === "utterance"
      ? rawUtteranceSchema.parse(raw)
      : rawProgressSchema.parse(raw);
  if (event.sessionId !== fence.sessionId) {
    throw new Error("caption session fence rejected");
  }
  if (event.generationId !== fence.generationId) {
    throw new Error("caption generation fence rejected");
  }
  if (!Number.isSafeInteger(fence.attempt) || fence.attempt <= 0) {
    throw new Error("caption attempt fence is invalid");
  }
  if (event.offsetBytes % 3_200 !== 0) {
    throw new Error("caption worker offset is not frame aligned");
  }
  if (event.type !== "utterance") {
    if (
      event.type === "sessionReady" &&
      event.modelSha256 !== fence.modelSha256
    ) {
      throw new Error("caption model fence rejected");
    }
    return {
      type: event.type,
      sessionId: event.sessionId,
      generationId: event.generationId,
      attempt: fence.attempt,
      offsetBytes: event.offsetBytes,
      nextSequence: event.nextSequence,
      backlogBytes: event.backlogBytes ?? 0,
    };
  }
  if (event.modelSha256 !== fence.modelSha256) {
    throw new Error("caption model fence rejected");
  }
  const textSha256 = createHash("sha256").update(event.text).digest("hex");
  if (textSha256 !== event.textSha256) {
    throw new Error("caption text hash mismatch");
  }
  const startMs = Math.round(event.startSeconds * 1_000);
  const endMs = Math.round(event.endSeconds * 1_000);
  if (endMs <= startMs || endMs > event.offsetBytes / 32) {
    throw new Error("caption utterance timing is invalid");
  }
  if (event.text.trim().length === 0) {
    return {
      type: "silence",
      sessionId: event.sessionId,
      generationId: event.generationId,
      attempt: fence.attempt,
      sequence: event.sequence,
      startMs,
      endMs,
      offsetBytes: event.offsetBytes,
      modelSha256: event.modelSha256,
    };
  }
  return {
    type: "utterance",
    sessionId: event.sessionId,
    generationId: event.generationId,
    attempt: fence.attempt,
    sequence: event.sequence,
    startMs,
    endMs,
    text: event.text.trim(),
    language: event.language,
    offsetBytes: event.offsetBytes,
    modelSha256: event.modelSha256,
  };
}
