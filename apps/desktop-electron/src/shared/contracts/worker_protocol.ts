import { z } from "zod";

export const workerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("progress"),
      operationId: z.string().min(1),
      attempt: z.number().int().positive(),
      sourceIdentity: z.string().min(1),
      fraction: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("result"),
      operationId: z.string().min(1),
      attempt: z.number().int().positive(),
      sourceIdentity: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("error"),
      operationId: z.string().min(1),
      attempt: z.number().int().positive(),
      sourceIdentity: z.string().min(1),
      code: z.string().min(1),
    })
    .strict(),
]);

export type WorkerFrame = z.infer<typeof workerFrameSchema>;
