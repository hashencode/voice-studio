import { z } from "zod";

export const localModelBundleIdSchema = z.enum([
  "formal-transcription",
  "live-caption",
]);
export const localModelBundleStateSchema = z.enum([
  "not-installed",
  "downloading",
  "paused",
  "installing",
  "installed",
  "failed",
  "corrupt",
  "storage-unavailable",
]);
export const localModelOperationKindSchema = z.enum([
  "download",
  "install",
  "delete",
  "redownload",
  "migration",
  "cleanup",
]);
export const modelMigrationPhaseSchema = z.enum([
  "preparing",
  "copying",
  "verifying",
  "switching",
  "probing",
  "cleaning",
  "cleanup-required",
  "completed",
  "canceled",
  "recovery-required",
]);

export const runtimeHealthSchema = z
  .object({
    state: z.enum(["ready", "damaged"]),
    message: z.string().min(1).max(240),
    identity: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const localModelBundleSnapshotSchema = z
  .object({
    id: localModelBundleIdSchema,
    displayName: z.string().min(1).max(80),
    state: localModelBundleStateSchema,
    version: z.string().min(1).max(128).nullable(),
    installedBytes: z.number().int().nonnegative().safe(),
    expectedBytes: z.number().int().nonnegative().safe(),
    progressBytes: z.number().int().nonnegative().safe(),
    message: z.string().min(1).max(240).nullable(),
    distributionEligible: z.boolean(),
  })
  .strict();

export const localModelOperationSnapshotSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
    kind: localModelOperationKindSchema,
    bundleId: localModelBundleIdSchema.nullable(),
    phase: modelMigrationPhaseSchema.nullable(),
    cancelable: z.boolean(),
    copiedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    message: z.string().min(1).max(240).nullable(),
  })
  .strict();

export const localModelSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    runtime: runtimeHealthSchema,
    storage: z
      .object({
        state: z.enum([
          "ready",
          "unavailable",
          "cleanup-required",
          "recovery-required",
        ]),
        displayPath: z.string().min(1).max(512),
        storeId: z.string().min(1).max(128).nullable(),
        usedBytes: z.number().int().nonnegative().safe(),
      })
      .strict(),
    bundles: z
      .array(localModelBundleSnapshotSchema)
      .length(2)
      .refine(
        (bundles) => new Set(bundles.map((item) => item.id)).size === 2,
        "local model bundle ids must be unique",
      ),
    operation: localModelOperationSnapshotSchema.nullable(),
    leaseCount: z.number().int().nonnegative().safe(),
    processingTaskCount: z.number().int().nonnegative().safe(),
    canChangeRoot: z.boolean(),
  })
  .strict();

export const localModelIntentSchema = z
  .object({
    action: z.enum([
      "download",
      "pause",
      "resume",
      "cancel",
      "delete",
      "redownload",
      "cancel-migration",
      "retry-cleanup",
    ]),
    bundleId: localModelBundleIdSchema.optional(),
    expectedRevision: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsBundle = !["cancel-migration", "retry-cleanup"].includes(
      value.action,
    );
    if (needsBundle !== (value.bundleId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: needsBundle
          ? "bundle id is required for this action"
          : "bundle id is not allowed for this action",
      });
    }
  });

export const changeLocalModelRootRequestSchema = z
  .object({ expectedRevision: z.number().int().nonnegative().safe() })
  .strict();
export const localModelSnapshotRequestSchema = z.object({}).strict();

export const localModelCapabilityReasonSchema = z.enum([
  "model-not-installed",
  "storage-unavailable",
  "runtime-damaged",
  "busy",
  "model-corrupt",
]);

export type LocalModelBundleId = z.infer<typeof localModelBundleIdSchema>;
export type LocalModelBundleSnapshot = z.infer<
  typeof localModelBundleSnapshotSchema
>;
export type LocalModelSnapshot = z.infer<typeof localModelSnapshotSchema>;
export type LocalModelIntent = z.infer<typeof localModelIntentSchema>;
export type LocalModelCapabilityReason = z.infer<
  typeof localModelCapabilityReasonSchema
>;
