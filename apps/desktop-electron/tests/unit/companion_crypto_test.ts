import { describe, expect, it } from "vitest";

import {
  companionX25519Secret,
  CompanionCryptoSession,
  CompanionCryptoError,
  CompanionReceiverCryptoSession,
  deriveCompanionPairingCredential,
  generateCompanionX25519KeyPair,
} from "../../src/main/domain/companion/companion_crypto";

const credential = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const initiatorNonce = Buffer.alloc(32, 0x11);
const responderNonce = Buffer.alloc(32, 0x22);

describe("Dart companion crypto wire contract", () => {
  it("matches the fixed HKDF/AES wire vector", () => {
    const sender = new CompanionCryptoSession({
      role: "initiator",
      sessionId: "session-vector",
      sharedCredential: credential,
      initiatorNonce,
      responderNonce,
      expiresAtMs: 2_000,
      nowMs: () => 1_000,
    });
    expect(
      sender.sealControl("capability", "message-vector", {
        resume: true,
        receipts: true,
      }),
    ).toBe(
      '{"schema":"companion-media-transfer/v1","sessionId":"session-vector","counter":0,"ciphertext":"qUG33d2XkOwfiWRbyuhQqtGaThywHD3r3xAJZkYmLURxYFpYC6VbNx/hnbnlM2iOSZA8FhWndb9F8NAZefDvnkvBqHTw9GvODKJ+W+xEr6/jP48QFB25vGg0fZq38MluUOz3wPuTBAUmH/wyl7SQfrVqfGX8tFHrstIzv3a9zcGPiB0QY9cHLNiySfwTCduoK2zH0Xw1rh+jUOIAcj0wCaw8na1umDwBLF4gOA==","mac":"UryOyuC7aEgaqwB7H2km1w=="}',
    );
  });

  it("derives distinct, symmetric X25519 pairing credentials", () => {
    const initiator = generateCompanionX25519KeyPair();
    const responder = generateCompanionX25519KeyPair();
    const left = companionX25519Secret(
      initiator.privateKey,
      responder.publicKey,
    );
    const right = companionX25519Secret(
      responder.privateKey,
      initiator.publicKey,
    );
    expect(left).toEqual(right);
    const temporary = deriveCompanionPairingCredential(
      left,
      "pair-vector",
      "temporary-channel",
    );
    const transcriptHash = Buffer.alloc(32, 0x77);
    const durable = deriveCompanionPairingCredential(
      right,
      "pair-vector",
      "long-term-peer",
      transcriptHash,
    );
    expect(temporary).toHaveLength(32);
    expect(durable).toHaveLength(32);
    expect(temporary).not.toEqual(durable);
    initiator.destroy();
    responder.destroy();
    expect(initiator.privateKey).toEqual(Buffer.alloc(32));
    expect(responder.privateKey).toEqual(Buffer.alloc(32));
    left.fill(0);
    right.fill(0);
    temporary.fill(0);
    durable.fill(0);
  });

  it("shares one monotonic receive counter across encrypted control and binary frames", () => {
    const now = () => 1_000;
    const receiver = new CompanionReceiverCryptoSession({
      sessionId: "session-1",
      sharedCredential: credential,
      initiatorNonce,
      responderNonce,
      expiresAtMs: 301_000,
      nowMs: now,
    });
    const sender = new CompanionCryptoSession({
      role: "initiator",
      sessionId: "session-1",
      sharedCredential: credential,
      initiatorNonce,
      responderNonce,
      expiresAtMs: 301_000,
      nowMs: now,
    });

    const manifest = sender.sealControl("manifest", "manifest-transfer-1", {
      transferId: "transfer-1",
    });
    expect(receiver.openControl(manifest)).toMatchObject({
      type: "manifest",
      messageId: "manifest-transfer-1",
      counter: 0,
    });
    expect(
      receiver.openBinary(sender.sealBinary(Buffer.from("audio"))),
    ).toEqual(Buffer.from("audio"));
    expect(() => receiver.openControl(manifest)).toThrowError(
      expect.objectContaining({ code: "REPLAY_REJECTED" }),
    );
  });

  it("rejects unknown wrapper fields, malformed canonical base64, and expired sessions", () => {
    const receiver = new CompanionReceiverCryptoSession({
      sessionId: "session-1",
      sharedCredential: credential,
      initiatorNonce,
      responderNonce,
      expiresAtMs: 999,
      nowMs: () => 1_000,
    });
    const malformed = JSON.stringify({
      schema: "companion-media-transfer/v1",
      sessionId: "session-1",
      counter: 0,
      ciphertext: "!!!!",
      mac: Buffer.alloc(16).toString("base64"),
      extra: true,
    });
    expect(() => receiver.openControl(malformed)).toThrow(CompanionCryptoError);
    expect(() => receiver.openBinary(Buffer.alloc(26))).toThrowError(
      expect.objectContaining({ code: "SESSION_EXPIRED" }),
    );
  });
});
