import { z } from "zod";

import { sha256Schema } from "./import_processing";

export const companionProtocol = "companion-audio-transfer/v2" as const;
export const companionCapability = "audio-transfer/v2" as const;
export const companionLimits = Object.freeze({
  maximumMetadataBytes: 64 * 1024,
  maximumChunkBytes: 1024 * 1024,
  defaultChunkBytes: 256 * 1024,
  maximumChunkCount: 65_536,
  maximumSourceBytes: 4 * 1024 * 1024 * 1024,
  checkpointLifetimeMs: 7 * 24 * 60 * 60 * 1_000,
  maximumHistoryItems: 100,
});

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const boundedTextSchema = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every((character) => (character.codePointAt(0) ?? 0) >= 32),
      "control characters are not allowed",
    );
const fingerprintSchema = z.string().regex(/^[A-Z2-7]{20,64}$/);
const timestampSchema = z.number().int().nonnegative().max(9_999_999_999_999);

export const companionTransferManifestSchema = z
  .object({
    schema: z.literal(companionProtocol),
    transferId: identifierSchema,
    sourceAssetId: identifierSchema,
    displayName: boundedTextSchema(160),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(companionLimits.maximumSourceBytes),
    wholeFileSha256: sha256Schema,
    chunkBytes: z
      .number()
      .int()
      .min(4_096)
      .max(companionLimits.maximumChunkBytes),
    chunkCount: z
      .number()
      .int()
      .positive()
      .max(companionLimits.maximumChunkCount),
    createdAtMs: timestampSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const expected = Math.ceil(manifest.sizeBytes / manifest.chunkBytes);
    if (manifest.chunkCount !== expected) {
      context.addIssue({
        code: "custom",
        path: ["chunkCount"],
        message: "chunk count does not match the bounded source size",
      });
    }
  });

export const companionPairingInviteSchema = z
  .object({
    schema: z.literal(companionProtocol),
    pairingId: identifierSchema,
    shortCode: z.string().regex(/^\d{6}$/),
    displayHandle: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    responderEphemeralPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    responderIdentityPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    manualEndpoint: z
      .object({
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9.:-]+$/),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    expiresAtMs: timestampSchema,
  })
  .strict();

export const companionTransferReceiptSchema = z
  .object({
    schema: z.literal(companionProtocol),
    receiptId: identifierSchema,
    transferId: identifierSchema,
    wholeFileSha256: sha256Schema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(companionLimits.maximumSourceBytes),
    desktopDeviceId: identifierSchema,
    desktopDeviceName: boundedTextSchema(80),
    desktopRecordingId: z.number().int().positive(),
    committedAtMs: timestampSchema,
    signature: z.string().min(1).max(512),
  })
  .strict();

export const companionDiscoveryStateSchema = z.enum([
  "disabled",
  "idle",
  "starting",
  "ready",
  "permission-denied",
  "permission-pending",
  "unavailable",
  "error",
]);

export const companionTransferStateSchema = z.enum([
  "awaiting",
  "transferring",
  "verifying",
  "importing",
  "committed",
  "canceled",
  "failed",
  "interrupted",
  "expired",
]);

export const companionSnapshotSchema = z
  .object({
    protocolVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    optIn: z.boolean(),
    discovery: z
      .object({
        state: companionDiscoveryStateSchema,
        manualFallbackAvailable: z.boolean(),
        errorCode: z.string().min(1).max(128).nullable(),
      })
      .strict(),
    pairing: z
      .object({
        state: z.enum([
          "idle",
          "inviting",
          "awaiting-peer",
          "paired",
          "code-mismatch",
          "expired",
          "locked",
          "error",
        ]),
        errorCode: z.string().min(1).max(128).nullable(),
      })
      .strict(),
    identity: z
      .object({
        deviceId: identifierSchema,
        deviceName: boundedTextSchema(80),
        fingerprint: fingerprintSchema,
        port: z.number().int().min(1).max(65_535).nullable(),
      })
      .strict()
      .nullable(),
    pairingInvite: companionPairingInviteSchema.nullable(),
    peers: z
      .array(
        z
          .object({
            deviceId: identifierSchema,
            displayName: boundedTextSchema(80),
            identityFingerprint: fingerprintSchema,
            trustState: z.enum(["active", "revoked", "credential-missing"]),
            availability: z.enum(["online", "offline", "unknown"]),
            pairedAtMs: timestampSchema,
            lastSeenAtMs: timestampSchema.nullable(),
          })
          .strict(),
      )
      .max(256),
    transfers: z
      .array(
        z
          .object({
            transferId: identifierSchema,
            peerDeviceId: identifierSchema,
            displayName: boundedTextSchema(160),
            wholeFileSha256: sha256Schema,
            sizeBytes: z
              .number()
              .int()
              .positive()
              .max(companionLimits.maximumSourceBytes),
            receivedBytes: z
              .number()
              .int()
              .nonnegative()
              .max(companionLimits.maximumSourceBytes),
            missingChunkCount: z
              .number()
              .int()
              .nonnegative()
              .max(companionLimits.maximumChunkCount),
            state: companionTransferStateSchema,
            revision: z.number().int().positive(),
            errorCode: z.string().min(1).max(128).nullable(),
            receipt: companionTransferReceiptSchema.nullable(),
            senderDeleteAllowed: z.boolean(),
            updatedAtMs: timestampSchema,
          })
          .strict(),
      )
      .max(companionLimits.maximumHistoryItems),
  })
  .strict();

const idempotencyKeySchema = z
  .string()
  .min(12)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const companionSnapshotRequestSchema = z.object({}).strict();
export const companionOptInRequestSchema = z
  .object({ enabled: z.boolean(), idempotencyKey: idempotencyKeySchema })
  .strict();
export const companionPairingInviteRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema })
  .strict();
export const companionPeerRevokeRequestSchema = z
  .object({ deviceId: identifierSchema, idempotencyKey: idempotencyKeySchema })
  .strict();
export const companionTransferCancelRequestSchema = z
  .object({
    transferId: identifierSchema,
    expectedRevision: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const companionTransferRetryRequestSchema =
  companionTransferCancelRequestSchema;

export type CompanionTransferManifest = z.infer<
  typeof companionTransferManifestSchema
>;
export type CompanionPairingInvite = z.infer<
  typeof companionPairingInviteSchema
>;
export type CompanionTransferReceipt = z.infer<
  typeof companionTransferReceiptSchema
>;
export type CompanionSnapshot = z.infer<typeof companionSnapshotSchema>;
export type CompanionOptInRequest = z.infer<typeof companionOptInRequestSchema>;
export type CompanionPairingInviteRequest = z.infer<
  typeof companionPairingInviteRequestSchema
>;
export type CompanionPeerRevokeRequest = z.infer<
  typeof companionPeerRevokeRequestSchema
>;
export type CompanionTransferCancelRequest = z.infer<
  typeof companionTransferCancelRequestSchema
>;
export type CompanionTransferRetryRequest = z.infer<
  typeof companionTransferRetryRequestSchema
>;
