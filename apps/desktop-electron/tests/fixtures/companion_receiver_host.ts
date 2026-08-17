import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { CompanionReceiver } from "../../src/main/domain/companion/companion_receiver";
import { companionFingerprint } from "../../src/main/domain/companion/companion_crypto";
import { openElectronDatabase } from "../../src/main/storage/database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

const [transferRoot] = process.argv.slice(2);
if (!transferRoot) throw new Error("transfer root is required");
const credential = await readCredentialFromPrivateStdin();
const identitySeed = Buffer.alloc(32, 0x5d);
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

const database = openElectronDatabase(":memory:");
const repository = new TransferRepository(database);
repository.pairPeer({
  deviceId: "mobile-interop-1",
  displayName: "Dart Interop Phone",
  identityFingerprint: "M".repeat(32),
  credentialIdentitySha256: createHash("sha256")
    .update(credential)
    .digest("hex"),
  pairedAtMs: 1,
});

const receiver = new CompanionReceiver({
  root: transferRoot,
  repository,
  security: {
    readCredential: async () => ({
      state: "available",
      credential: Uint8Array.from(credential),
    }),
  },
  identity: {
    ensureIdentity: async () => ({
      deviceId: "desktop-interop-1",
      deviceName: "Voice2Text Interop Mac",
      fingerprint: identityFingerprint,
    }),
  },
  handlers: {
    resolveInvite: async () => null,
    confirmInvite: async () => {
      throw new Error("unexpected pairing");
    },
    commitInvite: async () => {
      throw new Error("unexpected pairing");
    },
    commit: async (manifest, stagedSourcePath) => {
      const source = readFileSync(stagedSourcePath);
      const digest = createHash("sha256").update(source).digest("hex");
      if (
        digest !== manifest.wholeFileSha256 ||
        source.length !== manifest.sizeBytes
      ) {
        throw new Error("interop staged source mismatch");
      }
      seedImport(manifest.wholeFileSha256, manifest.sizeBytes);
      const receipt = {
        schema: "companion-audio-transfer/v2" as const,
        receiptId: `receipt-${manifest.transferId}`,
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        sizeBytes: manifest.sizeBytes,
        desktopDeviceId: "desktop-interop-1",
        desktopDeviceName: "Voice2Text Interop Mac",
        desktopRecordingId: 99,
        committedAtMs: Date.now(),
        signature: "",
      };
      receipt.signature = sign(
        null,
        Buffer.from(
          JSON.stringify({
            schema: receipt.schema,
            receiptId: receipt.receiptId,
            transferId: receipt.transferId,
            wholeFileSha256: receipt.wholeFileSha256,
            sizeBytes: receipt.sizeBytes,
            desktopDeviceId: receipt.desktopDeviceId,
            desktopDeviceName: receipt.desktopDeviceName,
            desktopRecordingId: receipt.desktopRecordingId,
            committedAtMs: receipt.committedAtMs,
          }),
        ),
        identityPrivateKey,
      ).toString("base64");
      repository.recordCommittedReceipt(manifest, receipt, {
        meetingId: 1,
        processingJobId: 5,
        recordingId: 99,
        sourceSha256: manifest.wholeFileSha256,
      });
      return receipt;
    },
  },
});

let seeded = false;
function seedImport(sourceSha256: string, sizeBytes: number): void {
  if (seeded) return;
  seeded = true;
  database.exec(`
    INSERT INTO media_authorities (
      id, content_sha256, normalized_path, source_sha256, size_bytes,
      duration_ms, receipt_json, created_at_ms
    ) VALUES (99, '${"d".repeat(64)}', '/private/tmp/interop.wav', '${sourceSha256}', ${sizeBytes}, 1000, '{}', 1);
    INSERT INTO meetings (
      id, idempotency_key, source_identity, display_name, media_path,
      duration_ms, media_authority_id, created_at_ms, updated_at_ms
    ) VALUES (1, 'interop-meeting', 'interop-source', 'Interop', '/private/tmp/interop.wav', 1000, 99, 1, 1);
    INSERT INTO processing_jobs (
      id, meeting_id, idempotency_key, operation_id, resource_identity,
      state, attempt, created_at_ms, updated_at_ms
    ) VALUES (5, 1, 'interop-processing', 'asr', 'interop-resource', 'queued', 0, 1, 1);
  `);
}

const listening = await receiver.start();
process.stdout.write(
  `${JSON.stringify({
    port: listening.port,
    identityFingerprint,
    identityPublicKey: identityPublicKey.toString("base64"),
  })}\n`,
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await receiver.stop();
  credential.fill(0);
  identitySeed.fill(0);
  identityPublicKey.fill(0);
  database.close();
  process.exit(0);
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

async function readCredentialFromPrivateStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > 32) throw new Error("credential input is invalid");
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  if (value.length !== 32) {
    value.fill(0);
    throw new Error("credential input is invalid");
  }
  return value;
}
