import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { connect, type Socket } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionCryptoSession } from "../../src/main/domain/companion/companion_crypto";
import {
  CompanionReceiver,
  encodeMissingChunkBitmap,
} from "../../src/main/domain/companion/companion_receiver";
import { openElectronDatabase } from "../../src/main/storage/database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

describe("companion-audio-transfer/v2 Node receiver", () => {
  let database: DatabaseSync | undefined;
  let root: string | undefined;
  let receiver: CompanionReceiver | undefined;
  afterEach(async () => {
    await receiver?.stop();
    receiver = undefined;
    database?.close();
    database = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("rejects a v1 peer before repository or handler mutation", async () => {
    database = openElectronDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "voice2text-companion-receiver-"));
    const repository = new TransferRepository(database);
    const resolveInvite = vi.fn(async () => null);
    const confirmInvite = vi.fn(async () => {
      throw new Error("unexpected pairing");
    });
    const commitInvite = vi.fn(async () => {
      throw new Error("unexpected pairing");
    });
    const commit = vi.fn();
    let reportError: ((code: string) => void) | undefined;
    const errorCode = new Promise<string>((resolve) => {
      reportError = resolve;
    });
    receiver = new CompanionReceiver({
      root: join(root, "transfers"),
      repository,
      security: { readCredential: vi.fn() },
      identity: {
        ensureIdentity: vi.fn(async () => ({
          deviceId: "desktop-1",
          deviceName: "Studio Mac",
          fingerprint: "D".repeat(32),
        })),
      },
      handlers: { resolveInvite, confirmInvite, commitInvite, commit },
      onSessionError: (code) => reportError?.(code),
    });
    const { port } = await receiver.start();
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await writeFrame(
      socket,
      0,
      Buffer.from(
        JSON.stringify({
          schema: "companion-media-transfer/v1",
          type: "sessionHello",
          sessionId: "legacy-session-1",
          deviceId: "legacy-mobile-1",
          deviceName: "Legacy Phone",
          fingerprint: "M".repeat(32),
          pairingId: null,
          initiatorNonce: Buffer.alloc(32, 0x11).toString("base64"),
          issuedAtMs: Date.now(),
        }),
      ),
    );

    await expectSocketClose(socket);
    await expect(errorCode).resolves.toBe("UNSUPPORTED_COMPANION_PROTOCOL");
    expect(resolveInvite).not.toHaveBeenCalled();
    expect(confirmInvite).not.toHaveBeenCalled();
    expect(commitInvite).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM companion_peers").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM companion_transfers")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("uses the real desktop identity and resumes only the missing verified chunks", async () => {
    database = openElectronDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "voice2text-companion-receiver-"));
    const repository = new TransferRepository(database);
    const credential = Buffer.alloc(32, 0x4c);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: sha256(credential),
      pairedAtMs: 1,
    });
    seedCommittedImport(database);
    const commit = vi.fn(async (manifest, stagedSourcePath: string) => {
      expect(readFileSync(stagedSourcePath)).toEqual(source);
      const receipt = {
        schema: "companion-audio-transfer/v2" as const,
        receiptId: `receipt-${manifest.transferId}`,
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        sizeBytes: manifest.sizeBytes,
        desktopDeviceId: "desktop-1",
        desktopDeviceName: "Studio Mac",
        desktopRecordingId: 99,
        committedAtMs: 2_000,
        signature: "c2lnbmF0dXJl",
      };
      repository.recordCommittedReceipt(manifest, receipt, {
        meetingId: 1,
        processingJobId: 5,
        recordingId: 99,
        sourceSha256: manifest.wholeFileSha256,
      });
      return receipt;
    });
    const changes: Array<{
      transferId: string;
      reason: string;
      revision: number;
    }> = [];
    receiver = new CompanionReceiver({
      root: join(root, "transfers"),
      repository,
      security: {
        readCredential: vi.fn(async () => ({
          state: "available" as const,
          credential: Uint8Array.from(credential),
        })),
      },
      identity: {
        ensureIdentity: vi.fn(async () => ({
          deviceId: "desktop-1",
          deviceName: "Studio Mac",
          fingerprint: "D".repeat(32),
        })),
      },
      handlers: {
        resolveInvite: vi.fn(async () => null),
        confirmInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commitInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commit,
      },
      onTransferChanged: (event) => changes.push(event),
    });
    const { port } = await receiver.start();

    const first = await connectClient(port, credential);
    expect(first.ack).toMatchObject({
      deviceId: "desktop-1",
      deviceName: "Studio Mac",
      fingerprint: "D".repeat(32),
    });
    await sendControl(
      first.socket,
      first.crypto,
      "manifest",
      "manifest-transfer-1",
      manifest,
    );
    expect(
      missingIndexes((await readControl(first.reader, first.crypto)).payload),
    ).toEqual([0, 1]);
    await sendChunk(first, 0);
    expect(
      missingIndexes((await readControl(first.reader, first.crypto)).payload),
    ).toEqual([1]);
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const resumed = await connectClient(port, credential);
    await sendControl(
      resumed.socket,
      resumed.crypto,
      "manifest",
      "manifest-transfer-1",
      manifest,
    );
    expect(
      missingIndexes(
        (await readControl(resumed.reader, resumed.crypto)).payload,
      ),
    ).toEqual([1]);
    await sendChunk(resumed, 1);
    await readControl(resumed.reader, resumed.crypto);
    await sendControl(
      resumed.socket,
      resumed.crypto,
      "receipt",
      "receipt-request-transfer-1",
      {
        request: true,
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
      },
    );
    const receipt = await readControl(resumed.reader, resumed.crypto);
    expect(receipt.payload).toMatchObject({
      transferId: "transfer-1",
      desktopDeviceId: "desktop-1",
    });
    expect(repository.getTransfer("transfer-1")?.senderDeleteAllowed).toBe(
      true,
    );
    expect(commit).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes.map((event) => event.reason)).toEqual(
      expect.arrayContaining([
        "chunk",
        "interrupted",
        "verifying",
        "importing",
        "committed",
      ]),
    );
    for (let index = 1; index < changes.length; index += 1) {
      expect(changes[index]!.revision).toBeGreaterThanOrEqual(
        changes[index - 1]!.revision,
      );
    }
    resumed.socket.end();
  });

  it("fences an externally canceled active transfer before late bytes or commit", async () => {
    database = openElectronDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "voice2text-companion-receiver-"));
    const repository = new TransferRepository(database);
    const credential = Buffer.alloc(32, 0x4c);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: sha256(credential),
      pairedAtMs: 1,
    });
    const commit = vi.fn();
    receiver = new CompanionReceiver({
      root: join(root, "transfers"),
      repository,
      security: {
        readCredential: vi.fn(async () => ({
          state: "available" as const,
          credential: Uint8Array.from(credential),
        })),
      },
      identity: {
        ensureIdentity: vi.fn(async () => ({
          deviceId: "desktop-1",
          deviceName: "Studio Mac",
          fingerprint: "D".repeat(32),
        })),
      },
      handlers: {
        resolveInvite: vi.fn(async () => null),
        confirmInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commitInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commit,
      },
    });
    const { port } = await receiver.start();
    const client = await connectClient(port, credential);
    await sendControl(
      client.socket,
      client.crypto,
      "manifest",
      "manifest-transfer-1",
      manifest,
    );
    await readControl(client.reader, client.crypto);
    const active = repository.getTransfer(manifest.transferId)!;
    repository.cancelTransfer(active.transferId, active.revision, Date.now());
    receiver.cancelTransfer(active.transferId);
    await expectSocketClose(client.socket);
    expect(repository.getTransfer(active.transferId)).toMatchObject({
      state: "canceled",
      stagingCleanupState: "complete",
      senderDeleteAllowed: false,
    });
    expect(commit).not.toHaveBeenCalled();
    receiver.cancelTransfer(active.transferId);
  });

  it("retries expired tombstone cleanup and never expires committed authority", async () => {
    database = openElectronDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "voice2text-companion-receiver-"));
    const repository = new TransferRepository(database);
    const credential = Buffer.alloc(32, 0x4c);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: sha256(credential),
      pairedAtMs: 1,
    });
    receiver = new CompanionReceiver({
      root: join(root, "transfers"),
      repository,
      security: {
        readCredential: vi.fn(async () => ({
          state: "available" as const,
          credential: Uint8Array.from(credential),
        })),
      },
      identity: {
        ensureIdentity: vi.fn(async () => ({
          deviceId: "desktop-1",
          deviceName: "Studio Mac",
          fingerprint: "D".repeat(32),
        })),
      },
      handlers: {
        resolveInvite: vi.fn(async () => null),
        confirmInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commitInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commit: vi.fn(),
      },
    });
    const { port } = await receiver.start();
    const client = await connectClient(port, credential);
    await sendControl(
      client.socket,
      client.crypto,
      "manifest",
      "manifest-transfer-1",
      manifest,
    );
    await readControl(client.reader, client.crypto);
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      repository.expireStaleCheckpoints(Date.now() + 8 * 24 * 60 * 60 * 1_000),
    ).toBe(1);
    expect(receiver.cleanupPendingStaging()).toBe(1);
    expect(repository.getTransfer(manifest.transferId)).toMatchObject({
      state: "expired",
      stagingCleanupState: "complete",
    });
    expect(readdirSync(join(root, "transfers"))).toEqual([]);
    expect(repository.expireStaleCheckpoints(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("accepts one client and releases a stalled handshake after its deadline", async () => {
    database = openElectronDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "voice2text-companion-receiver-"));
    const repository = new TransferRepository(database);
    const credential = Buffer.alloc(32, 0x4c);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: sha256(credential),
      pairedAtMs: 1,
    });
    receiver = new CompanionReceiver({
      root: join(root, "transfers"),
      repository,
      security: {
        readCredential: vi.fn(async () => ({
          state: "available" as const,
          credential: Uint8Array.from(credential),
        })),
      },
      identity: {
        ensureIdentity: vi.fn(async () => ({
          deviceId: "desktop-1",
          deviceName: "Studio Mac",
          fingerprint: "D".repeat(32),
        })),
      },
      handlers: {
        resolveInvite: vi.fn(async () => null),
        confirmInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commitInvite: vi.fn(async () => {
          throw new Error("unexpected pairing");
        }),
        commit: vi.fn(),
      },
      frameTimeoutMs: 25,
    });
    const { port } = await receiver.start();
    const stalled = connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      stalled.once("connect", resolve);
      stalled.once("error", reject);
    });
    const rejected = connect({ host: "127.0.0.1", port });
    await expectSocketClose(rejected);
    await expectSocketClose(stalled);

    const recovered = await connectClient(port, credential);
    expect(recovered.ack.deviceId).toBe("desktop-1");
    recovered.socket.destroy();
  });

  it("keeps full and sparse 4 GiB checkpoints within a single frame", () => {
    for (const count of [16_384, 65_536]) {
      const full = Array.from({ length: count }, (_, index) => index);
      const fullBitmap = encodeMissingChunkBitmap(count, full);
      const sparseBitmap = encodeMissingChunkBitmap(count, [
        0,
        count >>> 1,
        count - 1,
      ]);
      expect(Buffer.byteLength(fullBitmap, "utf8")).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(sparseBitmap, "utf8")).toBeLessThan(64 * 1024);
      expect(decodeMissingBitmap(count, fullBitmap)).toEqual(full);
      expect(decodeMissingBitmap(count, sparseBitmap)).toEqual([
        0,
        count >>> 1,
        count - 1,
      ]);
    }
  });
});

const source = Buffer.alloc(5_000, 0x7b);
const manifest = {
  schema: "companion-audio-transfer/v2" as const,
  transferId: "transfer-1",
  sourceAssetId: "asset-1",
  displayName: "meeting.wav",
  sizeBytes: source.length,
  wholeFileSha256: sha256(source),
  chunkBytes: 4_096,
  chunkCount: 2,
  createdAtMs: 1,
};

async function connectClient(port: number, credential: Buffer) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new TestFrameReader(socket);
  const initiatorNonce = Buffer.alloc(32, 0x11);
  await writeFrame(
    socket,
    0,
    Buffer.from(
      JSON.stringify({
        schema: "companion-audio-transfer/v2",
        type: "sessionHello",
        sessionId: "session-1",
        deviceId: "mobile-1",
        deviceName: "Test Phone",
        fingerprint: "M".repeat(32),
        pairingId: null,
        initiatorNonce: initiatorNonce.toString("base64"),
        issuedAtMs: Date.now(),
      }),
    ),
  );
  const ackFrame = await reader.next();
  const ack = JSON.parse(ackFrame.subarray(1).toString("utf8"));
  const crypto = new CompanionCryptoSession({
    role: "initiator",
    sessionId: "session-1",
    sharedCredential: credential,
    initiatorNonce,
    responderNonce: Buffer.from(ack.responderNonce, "base64"),
    expiresAtMs: ack.expiresAtMs,
  });
  return { socket, reader, crypto, ack };
}

async function sendChunk(
  client: Awaited<ReturnType<typeof connectClient>>,
  index: number,
) {
  const bytes =
    index === 0 ? source.subarray(0, 4_096) : source.subarray(4_096);
  await sendControl(
    client.socket,
    client.crypto,
    "chunk",
    `chunk-transfer-1-${index}`,
    {
      transferId: manifest.transferId,
      index,
      offset: index * manifest.chunkBytes,
      plaintextBytes: bytes.length,
      sha256: sha256(bytes),
    },
  );
  await writeFrame(client.socket, 1, client.crypto.sealBinary(bytes));
}

async function sendControl(
  socket: Socket,
  crypto: CompanionCryptoSession,
  type: string,
  messageId: string,
  payload: Record<string, unknown>,
) {
  await writeFrame(
    socket,
    0,
    Buffer.from(crypto.sealControl(type, messageId, payload)),
  );
}

async function readControl(
  reader: TestFrameReader,
  crypto: CompanionCryptoSession,
) {
  const frame = await reader.next();
  expect(frame[0]).toBe(0);
  return crypto.openControl(frame.subarray(1).toString("utf8"));
}

async function writeFrame(socket: Socket, kind: number, payload: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length + 1);
  const bytes = Buffer.concat([header, Buffer.from([kind]), payload]);
  if (!socket.write(bytes))
    await new Promise((resolve) => socket.once("drain", resolve));
}

async function expectSocketClose(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket remained open")),
      1_000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

class TestFrameReader {
  private buffer = Buffer.alloc(0);
  private waiters: Array<(value: Buffer) => void> = [];
  constructor(socket: Socket) {
    socket.on("data", (bytes) => {
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      ]);
      this.drain();
    });
  }
  next() {
    return new Promise<Buffer>((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }
  private drain() {
    while (this.waiters.length && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < length + 4) return;
      const frame = Buffer.from(this.buffer.subarray(4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
      this.waiters.shift()!(frame);
    }
  }
}

function seedCommittedImport(database: DatabaseSync) {
  database.exec(`
    INSERT INTO media_authorities (
      id, content_sha256, normalized_path, source_sha256, size_bytes,
      duration_ms, receipt_json, created_at_ms
    ) VALUES (99, '${"d".repeat(64)}', '/private/tmp/media.wav', '${manifest.wholeFileSha256}', 5000, 1000, '{}', 1);
    INSERT INTO meetings (
      id, idempotency_key, source_identity, display_name, media_path,
      duration_ms, media_authority_id, created_at_ms, updated_at_ms
    ) VALUES (1, 'meeting-1', 'source-1', 'Meeting', '/private/tmp/media.wav', 1000, 99, 1, 1);
    INSERT INTO processing_jobs (
      id, meeting_id, idempotency_key, operation_id, resource_identity,
      state, attempt, created_at_ms, updated_at_ms
    ) VALUES (5, 1, 'processing-1', 'asr', 'resource-1', 'queued', 0, 1, 1);
  `);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function missingIndexes(payload: Record<string, unknown>): number[] {
  return decodeMissingBitmap(
    Number(payload.chunkCount),
    String(payload.missingChunkBitmap),
  );
}

function decodeMissingBitmap(chunkCount: number, encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  return Array.from({ length: chunkCount }, (_, index) => index).filter(
    (index) => ((bytes[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0,
  );
}
