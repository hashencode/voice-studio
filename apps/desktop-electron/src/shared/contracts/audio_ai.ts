import { z } from "zod";

import { sha256Schema } from "./import_processing";

export const aiProviderIdSchema = z.enum(["deepseek", "openai-compatible"]);
export const aiProviderProfileIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const aiSecretStateSchema = z.enum([
  "available",
  "missing",
  "denied",
  "corrupt",
]);
export const fileVaultStateSchema = z.enum(["enabled", "disabled", "unknown"]);
export const audioAiStateSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export const audioAiErrorCodeSchema = z.enum([
  "AI_INVALID_CONFIGURATION",
  "AI_PROVIDER_MISSING",
  "AI_PROVIDER_FAILED",
  "AI_SECRET_MISSING",
  "AI_SECRET_DENIED",
  "AI_SECRET_CORRUPT",
  "AI_UNAUTHORIZED",
  "AI_RATE_LIMITED",
  "AI_SERVICE_UNAVAILABLE",
  "AI_NETWORK_UNAVAILABLE",
  "AI_UNTRUSTED_REDIRECT",
  "AI_REQUEST_TOO_LARGE",
  "AI_RESPONSE_TOO_LARGE",
  "AI_INVALID_OUTPUT",
  "AI_EVIDENCE_INVALID",
  "AI_CONSENT_REQUIRED",
  "AI_PROCESS_INTERRUPTED",
  "AI_ATTEMPT_CONFLICT",
]);

const aiProviderCapabilitiesSchema = z
  .object({
    selectable: z.literal(true),
    editable: z.boolean(),
    deletable: z.boolean(),
  })
  .strict();

export const customAiProviderProfileSchema = z
  .object({
    profileId: aiProviderProfileIdSchema,
    kind: z.literal("custom"),
    displayName: z.string().trim().min(1).max(128),
    protocol: aiProviderIdSchema,
    modelId: z.string().trim().min(1).max(256),
    modelSummary: z.string().trim().min(1).max(256),
    endpoint: z.string().url().max(2_048),
    endpointOrigin: z.string().url().max(2_048),
    processingLocation: z.literal("cloudDirect"),
    requiresConsent: z.literal(true),
    capabilities: aiProviderCapabilitiesSchema.extend({
      editable: z.literal(true),
      deletable: z.literal(true),
    }),
    secretState: aiSecretStateSchema,
  })
  .strict();

export const hostedAiProviderProfileSchema = z
  .object({
    profileId: aiProviderProfileIdSchema,
    kind: z.literal("hosted"),
    displayName: z.string().trim().min(1).max(128),
    modelSummary: z.string().trim().min(1).max(256),
    processingLocation: z.literal("cloudHosted"),
    requiresConsent: z.literal(true),
    capabilities: aiProviderCapabilitiesSchema.extend({
      editable: z.literal(false),
      deletable: z.literal(false),
    }),
  })
  .strict();

export const aiProviderProfileSchema = z.discriminatedUnion("kind", [
  customAiProviderProfileSchema,
  hostedAiProviderProfileSchema,
]);

export const aiSettingsSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    profiles: z.array(aiProviderProfileSchema).max(100),
    selectedProfileId: aiProviderProfileIdSchema.nullable(),
    deviceSecurity: z
      .object({
        kind: z.literal("device-security"),
        fileVaultState: fileVaultStateSchema,
        applicationLayerEncryption: z.literal("not-claimed"),
      })
      .strict(),
  })
  .strict();

export const audioAiEvidenceSchema = z
  .object({
    segmentId: z.number().int().positive(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .strict();

export const audioAiNoteSchema = z
  .object({
    noteId: z.number().int().positive(),
    schemaVersion: z.literal("audio_intelligence_output/v1"),
    suggestedTitle: z.string().min(1).max(512).nullable(),
    audioType: z.string().min(1).max(128).nullable(),
    items: z
      .array(
        z
          .object({
            insightId: z.number().int().positive(),
            kind: z.string().min(1).max(128),
            body: z.string().min(1).max(4_000),
            evidence: z.array(audioAiEvidenceSchema).min(1).max(20),
            actionOwner: z.string().min(1).max(512).nullable(),
            actionDueAtMs: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const audioAiConsentIdentitySchema = z
  .object({
    version: z.literal(1),
    profileId: aiProviderProfileIdSchema,
    providerId: aiProviderIdSchema,
    endpointOrigin: z.string().url().max(2_048),
    endpointIdentitySha256: sha256Schema,
    transcriptScopeSha256: sha256Schema,
  })
  .strict();

export const audioAiConsentPreviewSchema = z
  .object({
    audioId: z.number().int().positive(),
    generationId: z.number().int().positive(),
    profileId: aiProviderProfileIdSchema,
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1).max(256),
    endpointOrigin: z.string().url().max(2_048),
    endpointIdentitySha256: sha256Schema,
    transcriptScopeSha256: sha256Schema,
    audioTitle: z.string().max(512),
    segmentCount: z.number().int().positive().max(10_000),
    inputStartMs: z.number().int().nonnegative(),
    inputEndMs: z.number().int().positive(),
    requiresConsent: z.literal(true),
  })
  .strict();

export const audioAiSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    jobId: z.number().int().positive(),
    audioId: z.number().int().positive(),
    generationId: z.number().int().positive(),
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1).max(256),
    endpointOrigin: z.string().url().max(2_048),
    endpointIdentitySha256: sha256Schema,
    transcriptScopeSha256: sha256Schema,
    attempt: z.number().int().nonnegative(),
    state: audioAiStateSchema,
    errorCode: audioAiErrorCodeSchema.nullable(),
    note: audioAiNoteSchema.nullable(),
  })
  .strict();

export const getAiSettingsRequestSchema = z.object({}).strict();
const customAiProviderInputShape = {
  displayName: z.string().trim().min(1).max(128),
  protocol: aiProviderIdSchema,
  modelId: z.string().trim().min(1).max(256),
  endpoint: z.string().trim().url().max(2_048),
};
const expectedAiSettingsRevisionSchema = z.number().int().nonnegative();
const aiProviderSecretSchema = z.string().trim().min(1).max(4_096);

export const createAiProviderProfileRequestSchema = z
  .object({
    expectedRevision: expectedAiSettingsRevisionSchema,
    ...customAiProviderInputShape,
    secret: aiProviderSecretSchema,
  })
  .strict();
export const updateAiProviderProfileRequestSchema = z
  .object({
    expectedRevision: expectedAiSettingsRevisionSchema,
    profileId: aiProviderProfileIdSchema,
    ...customAiProviderInputShape,
    secret: aiProviderSecretSchema.optional(),
  })
  .strict();
export const selectAiProviderProfileRequestSchema = z
  .object({
    expectedRevision: expectedAiSettingsRevisionSchema,
    profileId: aiProviderProfileIdSchema,
  })
  .strict();
export const deleteAiProviderProfileRequestSchema = z
  .object({
    expectedRevision: expectedAiSettingsRevisionSchema,
    profileId: aiProviderProfileIdSchema,
  })
  .strict();
export const prepareAudioAiRequestSchema = z
  .object({
    audioId: z.number().int().positive(),
    generationId: z.number().int().positive(),
    templateId: z.string().trim().min(1).max(128),
  })
  .strict();
export const getAudioAiSnapshotRequestSchema = z
  .object({ audioId: z.number().int().positive() })
  .strict();
export const generateAudioAiRequestSchema = prepareAudioAiRequestSchema
  .extend({
    idempotencyKey: z
      .string()
      .min(12)
      .max(160)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    consent: audioAiConsentIdentitySchema,
  })
  .strict();
export const retryAudioAiRequestSchema = z
  .object({
    jobId: z.number().int().positive(),
    expectedAttempt: z.number().int().nonnegative(),
    idempotencyKey: z
      .string()
      .min(12)
      .max(160)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    consent: audioAiConsentIdentitySchema,
  })
  .strict();

export type AiSettingsSnapshot = z.infer<typeof aiSettingsSnapshotSchema>;
export type AiProviderProfile = z.infer<typeof aiProviderProfileSchema>;
export type CustomAiProviderProfile = z.infer<
  typeof customAiProviderProfileSchema
>;
export type CreateAiProviderProfileRequest = z.infer<
  typeof createAiProviderProfileRequestSchema
>;
export type UpdateAiProviderProfileRequest = z.infer<
  typeof updateAiProviderProfileRequestSchema
>;
export type SelectAiProviderProfileRequest = z.infer<
  typeof selectAiProviderProfileRequestSchema
>;
export type DeleteAiProviderProfileRequest = z.infer<
  typeof deleteAiProviderProfileRequestSchema
>;
export type AudioAiErrorCode = z.infer<typeof audioAiErrorCodeSchema>;
export type AudioAiConsentPreview = z.infer<typeof audioAiConsentPreviewSchema>;
export type AudioAiSnapshot = z.infer<typeof audioAiSnapshotSchema>;
export type GenerateAudioAiRequest = z.infer<
  typeof generateAudioAiRequestSchema
>;
export type RetryAudioAiRequest = z.infer<typeof retryAudioAiRequestSchema>;
