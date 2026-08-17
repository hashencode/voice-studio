import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

import {
  canonicalCompanionPairingTranscript,
  companionFingerprint,
  companionX25519Secret,
  deriveCompanionPairingCredential,
  generateCompanionX25519KeyPair,
} from "../../src/main/domain/companion/companion_crypto";
import { CompanionReceiver } from "../../src/main/domain/companion/companion_receiver";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

const database = openAudioDatabase(":memory:");
const repository = new TransferRepository(database);
const identitySeed = Buffer.alloc(32, 0x6d);
const identityPrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    identitySeed,
  ]),
  format: "der",
  type: "pkcs8",
});
const identityPublicKey = Buffer.from(
  createPublicKey(identityPrivateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32),
);
const identityFingerprint = companionFingerprint(identityPublicKey);
const responderEphemeral = generateCompanionX25519KeyPair();
const pairingId = "pair-dart-node-wire-1";
const shortCode = "314159";
const expiresAtMs = Date.now() + 120_000;
const delayFinalAcknowledgement = process.argv[3] === "delay-final-ack";
let storedCredential: Buffer | null = null;
let commitCount = 0;
let prepared:
  | {
      deviceId: string;
      deviceName: string;
      fingerprint: string;
      transcriptHash: string;
    }
  | undefined;

const receiver = new CompanionReceiver({
  root: process.argv[2]!,
  repository,
  security: {
    readCredential: async () =>
      storedCredential
        ? {
            state: "available" as const,
            credential: Uint8Array.from(storedCredential),
          }
        : { state: "missing" as const },
  },
  identity: {
    ensureIdentity: async () => ({
      deviceId: "desktop-pairing-1",
      deviceName: "Pairing Interop Mac",
      fingerprint: identityFingerprint,
    }),
  },
  handlers: {
    resolveInvite: async (input) => {
      if (input.pairingId !== pairingId || Date.now() > expiresAtMs)
        return null;
      const shared = companionX25519Secret(
        responderEphemeral.privateKey,
        input.initiatorEphemeralPublicKey,
      );
      try {
        return {
          temporaryCredential: deriveCompanionPairingCredential(
            shared,
            pairingId,
            "temporary-channel",
          ),
          responderEphemeralPublicKey: Buffer.from(
            responderEphemeral.publicKey,
          ),
          responderIdentityPublicKey: Buffer.from(identityPublicKey),
          expiresAtMs,
        };
      } finally {
        shared.fill(0);
      }
    },
    confirmInvite: async (input) => {
      if (input.shortCode !== shortCode)
        throw new Error("PAIRING_CODE_MISMATCH");
      const canonical = canonicalCompanionPairingTranscript(input.transcript);
      prepared = {
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        fingerprint: input.fingerprint,
        transcriptHash: createHash("sha256").update(canonical).digest("hex"),
      };
      return {
        responderIdentityPublicKey: Buffer.from(identityPublicKey),
        responderSignature: sign(null, canonical, identityPrivateKey),
      };
    },
    commitInvite: async (input) => {
      commitCount += 1;
      if (
        !prepared ||
        prepared.transcriptHash !== input.transcriptHash ||
        prepared.deviceId !== input.deviceId ||
        prepared.fingerprint !== input.fingerprint
      ) {
        throw new Error("PAIRING_COMMIT_MISMATCH");
      }
      const initiatorEphemeral = Buffer.from(
        input.transcript.initiatorEphemeralPublicKey,
        "base64",
      );
      const shared = companionX25519Secret(
        responderEphemeral.privateKey,
        initiatorEphemeral,
      );
      const transcriptHash = Buffer.from(input.transcriptHash, "hex");
      try {
        storedCredential = deriveCompanionPairingCredential(
          shared,
          pairingId,
          "long-term-peer",
          transcriptHash,
        );
        repository.pairPeer({
          deviceId: input.deviceId,
          displayName: input.deviceName,
          identityFingerprint: input.fingerprint,
          credentialIdentitySha256: createHash("sha256")
            .update(storedCredential)
            .digest("hex"),
          pairedAtMs: Date.now(),
        });
        if (delayFinalAcknowledgement) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        initiatorEphemeral.fill(0);
        shared.fill(0);
        transcriptHash.fill(0);
      }
    },
    commit: async () => {
      throw new Error("pairing probe must not commit media");
    },
  },
});

const listening = await receiver.start();
process.stdout.write(
  `${JSON.stringify({
    port: listening.port,
    pairingId,
    shortCode,
    expiresAtMs,
    targetDeviceId: "desktop-pairing-1",
    targetFingerprint: identityFingerprint,
    targetIdentityPublicKey: identityPublicKey.toString("base64"),
    targetEphemeralPublicKey: responderEphemeral.publicKey.toString("base64"),
  })}\n`,
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.race([
    receiver.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  storedCredential?.fill(0);
  responderEphemeral.destroy();
  identitySeed.fill(0);
  identityPublicKey.fill(0);
  database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("SIGUSR1", () => {
  process.stdout.write(`${JSON.stringify({ commitCount })}\n`);
});
