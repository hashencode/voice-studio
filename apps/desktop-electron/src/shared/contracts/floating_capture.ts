import { z } from "zod";

import { captureControlRequestSchema } from "./capture";

export const floatingCapturePhaseSchema = z.enum([
  "idle",
  "recording",
  "paused",
  "finalizing",
  "attention",
]);

export const floatingCaptureSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(128).nullable(),
    phase: floatingCapturePhaseSchema,
    elapsedMs: z.number().int().nonnegative(),
    allowedActions: z.array(captureControlRequestSchema.shape.action).max(2),
    attention: z.boolean(),
  })
  .strict();

export const floatingCaptureControlRequestSchema = captureControlRequestSchema;

export const floatingCaptureWindowActionRequestSchema = z
  .object({ action: z.enum(["hide", "open-details", "turn-off"]) })
  .strict();

export const floatingCapturePreferenceSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export const floatingCapturePreferenceRequestSchema = z.object({}).strict();

export type FloatingCaptureSnapshot = z.infer<
  typeof floatingCaptureSnapshotSchema
>;
export type FloatingCaptureControlRequest = z.infer<
  typeof floatingCaptureControlRequestSchema
>;
export type FloatingCaptureWindowAction = z.infer<
  typeof floatingCaptureWindowActionRequestSchema
>["action"];
export type FloatingCapturePreference = z.infer<
  typeof floatingCapturePreferenceSchema
>;
