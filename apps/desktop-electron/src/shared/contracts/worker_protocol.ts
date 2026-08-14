import { z } from "zod";

const fenceFields = {
  operationId: z.string().min(1),
  attempt: z.number().int().positive(),
  sourceIdentity: z.string().min(1),
  phase: z.enum(["asr", "diarization"]),
  protocolIdentity: z.string().min(1),
  sourceSha256: z.string().min(1),
  modelSha256: z.string().min(1),
  runtimeSha256: z.string().min(1),
};

export const workerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("progress"),
      ...fenceFields,
      fraction: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("result"),
      ...fenceFields,
      payload: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("error"),
      ...fenceFields,
      code: z.string().min(1),
    })
    .strict(),
]);

export type WorkerFrame = z.infer<typeof workerFrameSchema>;
