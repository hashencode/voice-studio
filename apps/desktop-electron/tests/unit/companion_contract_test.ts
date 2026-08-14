import { describe, expect, it } from "vitest";

import {
  companionPairingInviteSchema,
  companionTransferManifestSchema,
  companionTransferReceiptSchema,
} from "../../src/shared/contracts";

describe("U11 companion contracts", () => {
  it("freezes the versioned bounded transfer manifest", () => {
    const manifest = companionTransferManifestSchema.parse({
      schema: "companion-media-transfer/v1",
      transferId: "transfer-1",
      sourceAssetId: "mobile-recording-1",
      displayName: "meeting.wav",
      sizeBytes: 4_097,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 2,
      createdAtMs: 1,
    });
    expect(manifest.chunkCount).toBe(2);
    expect(
      companionTransferManifestSchema.safeParse({
        ...manifest,
        chunkCount: 1,
      }).success,
    ).toBe(false);
    expect(
      companionTransferManifestSchema.safeParse({
        ...manifest,
        sizeBytes: 4 * 1024 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });

  it("exposes only a public manual endpoint and bounds invitation expiry", () => {
    const invitation = companionPairingInviteSchema.parse({
      schema: "companion-media-transfer/v1",
      pairingId: "pair-1",
      shortCode: "123456",
      displayHandle: "pair-1:desktop-1:ABCDEFGHIJKL",
      responderEphemeralPublicKey: Buffer.alloc(32, 1).toString("base64"),
      responderIdentityPublicKey: Buffer.alloc(32, 2).toString("base64"),
      manualEndpoint: { host: "192.168.1.20", port: 4242 },
      expiresAtMs: 120_000,
    });
    expect(invitation).toMatchObject({ shortCode: "123456" });
    expect(JSON.stringify(invitation)).not.toMatch(/credential|secret|token/i);
    expect(
      companionPairingInviteSchema.safeParse({
        schema: "companion-media-transfer/v1",
        pairingId: "pair-1",
        shortCode: "12345",
        displayHandle: "pair-1:desktop-1:ABCDEFGHIJKL",
        responderEphemeralPublicKey: Buffer.alloc(32, 1).toString("base64"),
        responderIdentityPublicKey: Buffer.alloc(32, 2).toString("base64"),
        manualEndpoint: { host: "192.168.1.20", port: 4242 },
        expiresAtMs: 120_000,
      }).success,
    ).toBe(false);
  });

  it("requires a bounded signed durable receipt before sender deletion", () => {
    const receipt = companionTransferReceiptSchema.parse({
      schema: "companion-media-transfer/v1",
      receiptId: "receipt-transfer-1",
      transferId: "transfer-1",
      wholeFileSha256: "a".repeat(64),
      sizeBytes: 4_097,
      desktopDeviceId: "desktop-1",
      desktopDeviceName: "Studio Mac",
      desktopRecordingId: 7,
      committedAtMs: 3,
      signature: "c2lnbmF0dXJl",
    });
    expect(receipt.signature).toBeTruthy();
    expect(
      companionTransferReceiptSchema.safeParse({
        ...receipt,
        signature: "",
      }).success,
    ).toBe(false);
  });
});
