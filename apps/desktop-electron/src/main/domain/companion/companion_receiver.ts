import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import {
  companionLimits,
  companionProtocol,
  companionTransferManifestSchema,
  companionTransferReceiptSchema,
  type CompanionTransferManifest,
  type CompanionTransferReceipt,
} from "../../../shared/contracts";
import {
  SecureCompanionTransferStore,
  type CompanionWireChunk,
} from "../../features/companion/secure_transfer_store";
import { TransferRepository } from "../../storage/repositories/transfer_repository";
import type { CompanionTransferRecord } from "../../storage/repositories/transfer_repository";
import type {
  CompanionIdentityPort,
  CompanionNativeSecurityPort,
  CompanionReceiverPort,
} from "./companion_service";
import {
  canonicalCompanionPairingTranscript,
  companionFingerprint,
  CompanionReceiverCryptoSession,
  decodeCanonicalBase64,
  type CompanionPairingTranscriptValue,
  verifyCompanionPairingSignature,
} from "./companion_crypto";

const maximumFrameBytes = companionLimits.maximumChunkBytes + 4_096;
const handshakeMaximumBytes = 4_096;
const defaultFrameTimeoutMs = 30_000;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const fingerprint = /^[A-Z2-7]{20,64}$/;
const sha256 = /^[a-f0-9]{64}$/;

export class CompanionReceiverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanionReceiverError";
  }
}

export interface CompanionReceiverHandlers {
  resolveInvite(input: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    initiatorEphemeralPublicKey: Buffer;
  }):
    | Promise<CompanionResolvedPairingInvite | null>
    | CompanionResolvedPairingInvite
    | null;
  confirmInvite(input: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    shortCode: string;
    transcript: CompanionPairingTranscriptValue;
    initiatorIdentityPublicKey: Buffer;
    initiatorSignature: Buffer;
  }): Promise<{
    responderIdentityPublicKey: Buffer;
    responderSignature: Buffer;
  }>;
  commitInvite(input: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    transcript: CompanionPairingTranscriptValue;
    transcriptHash: string;
  }): Promise<void>;
  commit(
    manifest: CompanionTransferManifest,
    stagedSourcePath: string,
  ): Promise<CompanionTransferReceipt>;
}

export interface CompanionResolvedPairingInvite {
  temporaryCredential: Buffer;
  responderEphemeralPublicKey: Buffer;
  responderIdentityPublicKey: Buffer;
  expiresAtMs: number;
}

export type CompanionTransferChangeReason =
  | "chunk"
  | "interrupted"
  | "verifying"
  | "importing"
  | "committed"
  | "canceled"
  | "expired"
  | "revoked"
  | "cleanup";

export interface CompanionTransferChangedEvent {
  transferId: string;
  reason: CompanionTransferChangeReason;
  revision: number;
}

export class CompanionReceiver implements CompanionReceiverPort {
  private readonly store: SecureCompanionTransferStore;
  private server: Server | null = null;
  private activeSocket: Socket | null = null;
  private activeSession: Promise<void> | null = null;
  private activePeerDeviceId: string | null = null;
  private activeTransferId: string | null = null;
  private receiverIdentity: Awaited<
    ReturnType<CompanionIdentityPort["ensureIdentity"]>
  > | null = null;

  constructor(
    private readonly options: {
      root: string;
      repository: TransferRepository;
      security: Pick<CompanionNativeSecurityPort, "readCredential">;
      identity: Pick<CompanionIdentityPort, "ensureIdentity">;
      handlers: CompanionReceiverHandlers;
      host?: string;
      nowMs?: () => number;
      frameTimeoutMs?: number;
      availableBytes?: () => number;
      onTransferChanged?: (event: CompanionTransferChangedEvent) => void;
      onSessionError?: (code: string) => void;
    },
  ) {
    this.store = new SecureCompanionTransferStore(options.root, {
      availableBytes: options.availableBytes,
    });
  }

  async start(): Promise<{ port: number }> {
    const existing = this.server?.address();
    if (existing && typeof existing !== "string")
      return { port: existing.port };
    this.receiverIdentity = validateIdentity(
      await this.options.identity.ensureIdentity(),
    );
    this.cleanupPendingStaging();
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(
        { host: this.options.host ?? "0.0.0.0", port: 0, exclusive: true },
        () => {
          server.off("error", onError);
          resolve();
        },
      );
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new CompanionReceiverError(
        "LISTENER_UNAVAILABLE",
        "listener address unavailable",
      );
    }
    return { port: address.port };
  }

  async stop(): Promise<void> {
    const socket = this.activeSocket;
    this.activeSocket = null;
    socket?.destroy();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await this.activeSession?.catch(() => undefined);
    this.activeSession = null;
    this.activePeerDeviceId = null;
    this.activeTransferId = null;
    this.receiverIdentity = null;
  }

  cancelTransfer(transferId: string): void {
    if (this.activeTransferId === transferId) this.activeSocket?.destroy();
    this.cleanupPendingStaging(transferId, "canceled");
  }

  revokePeer(deviceId: string): void {
    if (this.activePeerDeviceId === deviceId) this.activeSocket?.destroy();
    this.cleanupPendingStaging(undefined, "revoked", deviceId);
  }

  cleanupPendingStaging(
    transferId?: string,
    reason: CompanionTransferChangeReason = "cleanup",
    peerDeviceId?: string,
  ): number {
    let cleaned = 0;
    for (const transfer of this.options.repository.pendingStagingCleanup()) {
      if (
        (transferId && transfer.transferId !== transferId) ||
        (peerDeviceId && transfer.peerDeviceId !== peerDeviceId)
      ) {
        continue;
      }
      this.store.discardStaging(transfer);
      const updated = this.options.repository.markStagingCleanupComplete(
        transfer.transferId,
        this.nowMs(),
      );
      this.emitChange(updated, reason);
      cleaned += 1;
    }
    return cleaned;
  }

  private accept(socket: Socket): void {
    if (this.activeSocket) {
      socket.destroy();
      return;
    }
    this.activeSocket = socket;
    socket.setNoDelay(true);
    const session = this.handle(socket)
      .catch((error: unknown) => {
        const candidate =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        this.options.onSessionError?.(
          typeof candidate === "string" &&
            /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate)
            ? candidate
            : "COMPANION_RECEIVER_INTERNAL",
        );
      })
      .finally(() => {
        if (this.activeSocket === socket) {
          this.activeSocket = null;
          this.activePeerDeviceId = null;
          this.activeTransferId = null;
        }
        socket.destroy();
        if (this.activeSession === session) this.activeSession = null;
      });
    this.activeSession = session;
  }

  private async handle(socket: Socket): Promise<void> {
    const identity = this.receiverIdentity;
    if (!identity)
      throw new CompanionReceiverError(
        "RECEIVER_STOPPED",
        "receiver is stopped",
      );
    const reader = new CompanionFrameReader(
      socket,
      this.options.frameTimeoutMs ?? defaultFrameTimeoutMs,
    );
    const hello = decodePlain(await reader.next());
    const helloKeys = [
      "schema",
      "type",
      "sessionId",
      "deviceId",
      "deviceName",
      "fingerprint",
      "pairingId",
      "initiatorNonce",
      "issuedAtMs",
    ];
    if (Object.hasOwn(hello, "initiatorEphemeralPublicKey")) {
      helloKeys.push("initiatorEphemeralPublicKey");
    }
    exactKeys(hello, helloKeys);
    if (hello.schema !== companionProtocol || hello.type !== "sessionHello") {
      throw new CompanionReceiverError(
        "INVALID_SESSION_HELLO",
        "session hello is invalid",
      );
    }
    const sessionId = requireIdentifier(hello.sessionId, "sessionId");
    const deviceId = requireIdentifier(hello.deviceId, "deviceId");
    this.activePeerDeviceId = deviceId;
    const deviceName = requireText(hello.deviceName, 80, "deviceName");
    const presentedFingerprint = requireFingerprint(hello.fingerprint);
    const pairingId =
      hello.pairingId === null
        ? null
        : requireIdentifier(hello.pairingId, "pairingId");
    const initiatorEphemeralPublicKey =
      hello.initiatorEphemeralPublicKey == null
        ? null
        : decodeCanonicalBase64(
            hello.initiatorEphemeralPublicKey,
            32,
            "initiatorEphemeralPublicKey",
          );
    const now = this.nowMs();
    const issuedAtMs = requireInteger(hello.issuedAtMs, "issuedAtMs");
    if (Math.abs(issuedAtMs - now) > 120_000) {
      throw new CompanionReceiverError(
        "SESSION_HELLO_EXPIRED",
        "session hello expired",
      );
    }
    const initiatorNonce = decodeCanonicalBase64(
      hello.initiatorNonce,
      32,
      "initiatorNonce",
    );
    let credential: Buffer | null = null;
    let invited = false;
    let resolvedInvite: CompanionResolvedPairingInvite | null = null;
    const peer = this.options.repository.peer(deviceId);
    if (pairingId && initiatorEphemeralPublicKey) {
      const resolved = await this.options.handlers.resolveInvite({
        pairingId,
        deviceId,
        deviceName,
        fingerprint: presentedFingerprint,
        initiatorEphemeralPublicKey,
      });
      if (!resolved)
        throw new CompanionReceiverError(
          "UNPAIRED_PEER",
          "invite is unavailable",
        );
      resolvedInvite = validateResolvedInvite(resolved, identity, now);
      credential = Buffer.from(resolved.temporaryCredential);
      resolved.temporaryCredential.fill(0);
      invited = true;
    } else if (peer?.trustState === "active") {
      if (peer.identityFingerprint !== presentedFingerprint) {
        throw new CompanionReceiverError(
          "PEER_KEY_CHANGED",
          "peer identity changed",
        );
      }
      const receipt = await this.options.security.readCredential({
        kind: "peer-shared",
        peerDeviceId: deviceId,
      });
      if (receipt.state !== "available") {
        throw new CompanionReceiverError(
          `PEER_CREDENTIAL_${receipt.state.toUpperCase()}`,
          "peer credential is unavailable",
        );
      }
      credential = Buffer.from(receipt.credential);
      receipt.credential.fill(0);
    } else {
      throw new CompanionReceiverError("UNPAIRED_PEER", "peer is not paired");
    }
    if (credential.length !== 32) {
      credential.fill(0);
      throw new CompanionReceiverError(
        "INVALID_CREDENTIAL",
        "peer credential is invalid",
      );
    }

    const responderNonce = randomBytes(32);
    let crypto: CompanionReceiverCryptoSession | null = null;
    try {
      const expiresAtMs = now + 5 * 60 * 1_000;
      await writePlain(socket, {
        schema: companionProtocol,
        type: "sessionHelloAck",
        sessionId,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        fingerprint: identity.fingerprint,
        responderNonce: responderNonce.toString("base64"),
        expiresAtMs,
      });
      crypto = new CompanionReceiverCryptoSession({
        sessionId,
        sharedCredential: credential,
        initiatorNonce,
        responderNonce,
        expiresAtMs,
        nowMs: () => this.nowMs(),
      });
      if (invited) {
        await this.completeWirePairing({
          socket,
          reader,
          crypto,
          identity,
          deviceId,
          deviceName,
          fingerprint: presentedFingerprint,
          pairingId: pairingId!,
          initiatorEphemeralPublicKey: initiatorEphemeralPublicKey!,
          resolved: resolvedInvite!,
        });
        return;
      }
      await this.transferLoop({
        socket,
        reader,
        crypto,
        deviceId,
        deviceName,
        fingerprint: presentedFingerprint,
        invited,
      });
    } finally {
      crypto?.destroy();
      credential.fill(0);
      initiatorNonce.fill(0);
      responderNonce.fill(0);
    }
  }

  private async completeWirePairing(context: {
    socket: Socket;
    reader: CompanionFrameReader;
    crypto: CompanionReceiverCryptoSession;
    identity: { deviceId: string; deviceName: string; fingerprint: string };
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    pairingId: string;
    initiatorEphemeralPublicKey: Buffer;
    resolved: CompanionResolvedPairingInvite;
  }): Promise<void> {
    const frame = await context.reader.next();
    if (frame[0] !== 0) {
      throw new CompanionReceiverError(
        "PAIRING_TRANSCRIPT_REQUIRED",
        "encrypted pairing transcript required",
      );
    }
    const envelope = context.crypto.openControl(
      frame.subarray(1).toString("utf8"),
    );
    if (envelope.type !== "pairingTranscript") {
      throw new CompanionReceiverError(
        "PAIRING_TRANSCRIPT_REQUIRED",
        "encrypted pairing transcript required",
      );
    }
    exactKeys(envelope.payload, [
      "transcript",
      "shortCode",
      "initiatorIdentityPublicKey",
      "initiatorSignature",
    ]);
    const transcript = parsePairingTranscript(envelope.payload.transcript);
    const shortCode = requirePairingCode(envelope.payload.shortCode);
    const initiatorIdentityPublicKey = decodeCanonicalBase64(
      envelope.payload.initiatorIdentityPublicKey,
      32,
      "initiatorIdentityPublicKey",
    );
    const initiatorSignature = decodeCanonicalBase64(
      envelope.payload.initiatorSignature,
      64,
      "initiatorSignature",
    );
    if (
      transcript.pairingId !== context.pairingId ||
      transcript.initiatorDeviceId !== context.deviceId ||
      transcript.initiatorFingerprint !== context.fingerprint ||
      transcript.initiatorEphemeralPublicKey !==
        context.initiatorEphemeralPublicKey.toString("base64") ||
      transcript.responderDeviceId !== context.identity.deviceId ||
      transcript.responderFingerprint !== context.identity.fingerprint ||
      transcript.responderEphemeralPublicKey !==
        context.resolved.responderEphemeralPublicKey.toString("base64") ||
      transcript.expiresAtMs !== context.resolved.expiresAtMs ||
      this.nowMs() > transcript.expiresAtMs
    ) {
      throw new CompanionReceiverError(
        "PAIRING_TRANSCRIPT_MISMATCH",
        "pairing transcript is not bound to this challenge",
      );
    }
    verifyCompanionPairingSignature(
      transcript,
      initiatorIdentityPublicKey,
      initiatorSignature,
      context.fingerprint,
    );
    const confirmed = await this.options.handlers.confirmInvite({
      pairingId: context.pairingId,
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      fingerprint: context.fingerprint,
      shortCode,
      transcript,
      initiatorIdentityPublicKey,
      initiatorSignature,
    });
    const responderIdentityPublicKey = Buffer.from(
      confirmed.responderIdentityPublicKey,
    );
    const responderSignature = Buffer.from(confirmed.responderSignature);
    try {
      if (
        !responderIdentityPublicKey.equals(
          context.resolved.responderIdentityPublicKey,
        ) ||
        companionFingerprint(responderIdentityPublicKey) !==
          context.identity.fingerprint
      ) {
        throw new CompanionReceiverError(
          "PAIRING_RESPONDER_IDENTITY_MISMATCH",
          "pairing responder identity changed",
        );
      }
      verifyCompanionPairingSignature(
        transcript,
        responderIdentityPublicKey,
        responderSignature,
        context.identity.fingerprint,
      );
      await writeSealed(
        context.socket,
        context.crypto,
        "pairingTranscript",
        `pairing-${context.pairingId}`,
        {
          transcript,
          responderIdentityPublicKey:
            responderIdentityPublicKey.toString("base64"),
          responderSignature: responderSignature.toString("base64"),
          verified: true,
        },
      );
      const transcriptHash = createHash("sha256")
        .update(canonicalCompanionPairingTranscript(transcript))
        .digest("hex");
      const commitFrame = await context.reader.next();
      if (commitFrame[0] !== 0) {
        throw new CompanionReceiverError(
          "PAIRING_COMMIT_REQUIRED",
          "encrypted pairing commit required",
        );
      }
      const commitEnvelope = context.crypto.openControl(
        commitFrame.subarray(1).toString("utf8"),
      );
      if (commitEnvelope.type !== "pairingTranscript") {
        throw new CompanionReceiverError(
          "PAIRING_COMMIT_REQUIRED",
          "encrypted pairing commit required",
        );
      }
      exactKeys(commitEnvelope.payload, ["commit", "transcriptHash"]);
      if (
        commitEnvelope.payload.commit !== true ||
        commitEnvelope.payload.transcriptHash !== transcriptHash
      ) {
        throw new CompanionReceiverError(
          "PAIRING_COMMIT_MISMATCH",
          "pairing commit does not match the verified transcript",
        );
      }
      await this.options.handlers.commitInvite({
        pairingId: context.pairingId,
        deviceId: context.deviceId,
        deviceName: context.deviceName,
        fingerprint: context.fingerprint,
        transcript,
        transcriptHash,
      });
      this.assertPeerAuthority(context.deviceId, context.fingerprint, false);
      await writeSealed(
        context.socket,
        context.crypto,
        "pairingTranscript",
        `paired-${context.pairingId}`,
        { paired: true, transcriptHash },
      );
    } finally {
      initiatorIdentityPublicKey.fill(0);
      initiatorSignature.fill(0);
      responderIdentityPublicKey.fill(0);
      responderSignature.fill(0);
    }
  }

  private async transferLoop(context: {
    socket: Socket;
    reader: CompanionFrameReader;
    crypto: CompanionReceiverCryptoSession;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    invited: boolean;
  }): Promise<void> {
    let manifest: CompanionTransferManifest | null = null;
    let pendingChunk: CompanionWireChunk | null = null;
    try {
      while (true) {
        this.assertPeerAuthority(
          context.deviceId,
          context.fingerprint,
          context.invited,
        );
        const frame = await context.reader.next();
        if (frame[0] === 1) {
          if (!manifest || !pendingChunk) {
            throw new CompanionReceiverError(
              "UNEXPECTED_BINARY_PACKET",
              "chunk header required",
            );
          }
          this.assertTransferReceiving(manifest.transferId);
          const bytes = context.crypto.openBinary(frame.subarray(1));
          this.store.writeVerifiedChunk(manifest, pendingChunk, bytes);
          const changed = this.options.repository.recordVerifiedChunk({
            ...pendingChunk,
            wholeFileSha256: manifest.wholeFileSha256,
            receivedAtMs: this.nowMs(),
          });
          this.emitChange(changed, "chunk");
          const chunkIndex = pendingChunk.index;
          pendingChunk = null;
          await this.writeCheckpoint(
            context.socket,
            context.crypto,
            manifest,
            `checkpoint-${chunkIndex}`,
          );
          continue;
        }
        if (frame[0] !== 0) {
          throw new CompanionReceiverError(
            "CONTROL_FRAME_REQUIRED",
            "control frame required",
          );
        }
        const envelope = context.crypto.openControl(
          frame.subarray(1).toString("utf8"),
        );
        if (pendingChunk) {
          throw new CompanionReceiverError(
            "BINARY_PACKET_REQUIRED",
            "pending chunk bytes required",
          );
        }
        switch (envelope.type) {
          case "manifest": {
            const incoming = companionTransferManifestSchema.parse(
              envelope.payload,
            );
            if (
              manifest &&
              JSON.stringify(manifest) !== JSON.stringify(incoming)
            ) {
              throw new CompanionReceiverError(
                "TRANSFER_ID_MISMATCH",
                "manifest changed in session",
              );
            }
            manifest = incoming;
            assertCheckpointEncodable(manifest.chunkCount);
            const durable = this.options.repository.beginTransfer(
              manifest,
              context.deviceId,
              this.nowMs(),
            );
            this.activeTransferId = manifest.transferId;
            if (!durable.receipt) {
              this.store.begin(manifest);
            }
            await this.writeCheckpoint(
              context.socket,
              context.crypto,
              manifest,
              "checkpoint-manifest",
            );
            break;
          }
          case "chunk": {
            if (!manifest) {
              throw new CompanionReceiverError(
                "MANIFEST_REQUIRED",
                "manifest required before chunk",
              );
            }
            this.assertTransferReceiving(manifest.transferId);
            pendingChunk = parseChunk(envelope.payload, manifest);
            break;
          }
          case "receipt": {
            if (!manifest)
              throw new CompanionReceiverError(
                "MANIFEST_REQUIRED",
                "manifest required",
              );
            exactKeys(envelope.payload, [
              "request",
              "transferId",
              "wholeFileSha256",
            ]);
            if (
              envelope.payload.request !== true ||
              envelope.payload.transferId !== manifest.transferId ||
              envelope.payload.wholeFileSha256 !== manifest.wholeFileSha256
            ) {
              throw new CompanionReceiverError(
                "INVALID_RECEIPT_REQUEST",
                "receipt request is invalid",
              );
            }
            let receipt =
              this.options.repository.getTransfer(manifest.transferId)
                ?.receipt ?? null;
            if (!receipt) {
              let transfer = this.options.repository.getTransfer(
                manifest.transferId,
              );
              if (!transfer) {
                throw new CompanionReceiverError(
                  "TRANSFER_NOT_FOUND",
                  "transfer is unavailable",
                );
              }
              if (
                ["awaiting", "transferring", "interrupted"].includes(
                  transfer.state,
                )
              ) {
                transfer = this.options.repository.claimVerification(
                  manifest,
                  this.nowMs(),
                );
                this.emitChange(transfer, "verifying");
              } else if (
                transfer.state !== "verifying" &&
                transfer.state !== "importing"
              ) {
                throw new CompanionReceiverError(
                  "TRANSFER_NOT_COMMITTABLE",
                  "transfer is not ready for receipt",
                );
              }
              const chunks = this.options.repository.verifiedChunks(
                manifest.transferId,
              );
              const staged = this.store.verifyAndStage(
                manifest,
                chunks.map((chunk) => ({
                  transferId: manifest!.transferId,
                  ...chunk,
                })),
              );
              if (transfer.state === "verifying") {
                transfer = this.options.repository.claimImport(
                  manifest.transferId,
                  transfer.revision,
                  transfer.destinationIdentity!,
                  this.nowMs(),
                );
                this.emitChange(transfer, "importing");
              }
              receipt = companionTransferReceiptSchema.parse(
                await this.options.handlers.commit(manifest, staged),
              );
            }
            const durable = this.options.repository.getTransfer(
              manifest.transferId,
            );
            if (
              !durable?.senderDeleteAllowed ||
              !durable.receipt ||
              JSON.stringify(durable.receipt) !== JSON.stringify(receipt)
            ) {
              throw new CompanionReceiverError(
                "RECEIPT_NOT_DURABLE",
                "sender deletion requires a durable committed receipt",
              );
            }
            this.cleanupPendingStaging(manifest.transferId, "committed");
            const committed = this.options.repository.getTransfer(
              manifest.transferId,
            );
            if (committed) this.emitChange(committed, "committed");
            await writeSealed(
              context.socket,
              context.crypto,
              "receipt",
              receipt.receiptId,
              receipt,
            );
            return;
          }
          case "cancel": {
            if (!manifest) return;
            exactKeys(envelope.payload, ["transferId", "reason"]);
            if (
              envelope.payload.transferId !== manifest.transferId ||
              envelope.payload.reason !== "user"
            ) {
              throw new CompanionReceiverError(
                "INVALID_CANCEL",
                "cancel request is invalid",
              );
            }
            const transfer = this.options.repository.getTransfer(
              manifest.transferId,
            );
            if (transfer && transfer.state !== "committed") {
              this.options.repository.cancelTransfer(
                transfer.transferId,
                transfer.revision,
                this.nowMs(),
              );
              this.cancelTransfer(manifest.transferId);
            }
            return;
          }
          default:
            throw new CompanionReceiverError(
              "UNEXPECTED_MESSAGE",
              "message is invalid in transfer stream",
            );
        }
      }
    } catch (error) {
      if (manifest) {
        const transfer = this.options.repository.getTransfer(
          manifest.transferId,
        );
        if (
          transfer &&
          ["awaiting", "transferring", "verifying", "importing"].includes(
            transfer.state,
          )
        ) {
          const interrupted = this.options.repository.interruptTransfer(
            manifest.transferId,
            this.nowMs(),
          );
          if (interrupted.state === "interrupted") {
            this.emitChange(interrupted, "interrupted");
          }
        }
      }
      throw error;
    }
  }

  private async writeCheckpoint(
    socket: Socket,
    crypto: CompanionReceiverCryptoSession,
    manifest: CompanionTransferManifest,
    messageId: string,
  ): Promise<void> {
    const prior = this.options.repository.getTransfer(
      manifest.transferId,
    )?.receipt;
    if (prior) {
      await writeSealed(socket, crypto, "checkpoint", messageId, {
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        chunkCount: manifest.chunkCount,
        missingChunkBitmap: encodeMissingChunkBitmap(manifest.chunkCount, []),
        updatedAtMs: this.nowMs(),
      });
      return;
    }
    const checkpoint = this.options.repository.checkpoint(
      manifest,
      this.nowMs(),
    );
    const chunks = this.options.repository.verifiedChunks(manifest.transferId);
    const missingChunks = this.store.missingChunks(
      manifest,
      chunks.map((chunk) => ({ transferId: manifest.transferId, ...chunk })),
    );
    await writeSealed(socket, crypto, "checkpoint", messageId, {
      transferId: checkpoint.transferId,
      wholeFileSha256: checkpoint.wholeFileSha256,
      chunkCount: manifest.chunkCount,
      missingChunkBitmap: encodeMissingChunkBitmap(
        manifest.chunkCount,
        missingChunks,
      ),
      updatedAtMs: checkpoint.updatedAtMs,
    });
  }

  private assertPeerAuthority(
    deviceId: string,
    presentedFingerprint: string,
    invited: boolean,
  ): void {
    if (invited) return;
    const peer = this.options.repository.peer(deviceId);
    if (
      peer?.trustState !== "active" ||
      peer.identityFingerprint !== presentedFingerprint
    ) {
      throw new CompanionReceiverError(
        "PEER_AUTHORITY_REVOKED",
        "peer authority is no longer active",
      );
    }
  }

  private assertTransferReceiving(transferId: string): void {
    const transfer = this.options.repository.getTransfer(transferId);
    if (
      !transfer ||
      !["awaiting", "transferring", "interrupted"].includes(transfer.state)
    ) {
      throw new CompanionReceiverError(
        "TRANSFER_NOT_RECEIVING",
        "transfer no longer accepts chunks",
      );
    }
  }

  private emitChange(
    transfer: CompanionTransferRecord,
    reason: CompanionTransferChangeReason,
  ): void {
    this.options.onTransferChanged?.({
      transferId: transfer.transferId,
      reason,
      revision: transfer.revision,
    });
  }

  private nowMs(): number {
    return (this.options.nowMs ?? Date.now)();
  }
}

export function encodeMissingChunkBitmap(
  chunkCount: number,
  missingChunks: readonly number[],
): string {
  assertCheckpointEncodable(chunkCount);
  const bytes = Buffer.alloc(Math.ceil(chunkCount / 8));
  for (const index of missingChunks) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount) {
      throw new CompanionReceiverError(
        "INVALID_CHECKPOINT",
        "missing chunk index is invalid",
      );
    }
    const byteIndex = index >>> 3;
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (index & 7));
  }
  return bytes.toString("base64");
}

function assertCheckpointEncodable(chunkCount: number): void {
  if (
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > companionLimits.maximumChunkCount
  ) {
    throw new CompanionReceiverError(
      "INVALID_CHECKPOINT",
      "checkpoint chunk count is invalid",
    );
  }
  const maximumEncodedBytes = Math.ceil(Math.ceil(chunkCount / 8) / 3) * 4;
  if (maximumEncodedBytes + 1_024 > maximumFrameBytes) {
    throw new CompanionReceiverError(
      "CHECKPOINT_TOO_LARGE",
      "checkpoint cannot fit in a protocol frame",
    );
  }
}

class CompanionFrameReader {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    resolve(frame: Buffer): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];
  private terminalError: Error | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (bytes) => {
      if (this.terminalError) return;
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      ]);
      this.drain();
      if (this.buffer.length > (maximumFrameBytes + 4) * 2) {
        this.fail(
          new CompanionReceiverError(
            "FRAME_SIZE_INVALID",
            "frame buffer exceeds limit",
          ),
        );
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(
        new CompanionReceiverError("CONNECTION_CLOSED", "connection closed"),
      ),
    );
  }

  next(): Promise<Buffer> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<Buffer>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(
            new CompanionReceiverError("FRAME_TIMEOUT", "next frame timed out"),
          );
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 2 || length > maximumFrameBytes) {
        this.fail(
          new CompanionReceiverError(
            "FRAME_SIZE_INVALID",
            "frame length is invalid",
          ),
        );
        return;
      }
      if (this.buffer.length < length + 4) return;
      const frame = Buffer.from(this.buffer.subarray(4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socket.destroy();
  }
}

async function writePlain(
  socket: Socket,
  value: Record<string, unknown>,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > handshakeMaximumBytes) {
    throw new CompanionReceiverError(
      "PLAIN_FRAME_TOO_LARGE",
      "handshake exceeds limit",
    );
  }
  await writeFrame(socket, 0, payload);
}

function decodePlain(frame: Buffer): Record<string, unknown> {
  if (frame[0] !== 0 || frame.length > handshakeMaximumBytes + 1) {
    throw new CompanionReceiverError(
      "INVALID_PLAIN_FRAME",
      "handshake frame is invalid",
    );
  }
  return parseObject(frame.subarray(1).toString("utf8"));
}

async function writeSealed(
  socket: Socket,
  crypto: CompanionReceiverCryptoSession,
  type: string,
  messageId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFrame(
    socket,
    0,
    Buffer.from(crypto.sealControl(type, messageId, payload), "utf8"),
  );
}

async function writeFrame(
  socket: Socket,
  kind: number,
  payload: Buffer,
): Promise<void> {
  const length = payload.length + 1;
  if (length < 2 || length > maximumFrameBytes) {
    throw new CompanionReceiverError(
      "FRAME_SIZE_INVALID",
      "outgoing frame is invalid",
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(length, 0);
  const frame = Buffer.concat([header, Buffer.from([kind]), payload]);
  if (socket.destroyed || !socket.writable) {
    throw new CompanionReceiverError(
      "CONNECTION_CLOSED",
      "connection closed before write",
    );
  }
  if (!socket.write(frame)) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(
          new CompanionReceiverError("WRITE_TIMEOUT", "frame write timed out"),
        );
      }, defaultFrameTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("drain", onDrain);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(
          new CompanionReceiverError(
            "CONNECTION_CLOSED",
            "connection closed during write",
          ),
        );
      };
      socket.once("drain", onDrain);
      socket.once("error", onError);
      socket.once("close", onClose);
      if (socket.destroyed || !socket.writable) onClose();
    });
  }
}

function parseChunk(
  payload: Record<string, unknown>,
  manifest: CompanionTransferManifest,
): CompanionWireChunk {
  exactKeys(payload, [
    "transferId",
    "index",
    "offset",
    "plaintextBytes",
    "sha256",
  ]);
  const chunk = {
    transferId: requireIdentifier(payload.transferId, "transferId"),
    index: requireInteger(payload.index, "index"),
    offset: requireInteger(payload.offset, "offset"),
    plaintextBytes: requireInteger(payload.plaintextBytes, "plaintextBytes"),
    sha256: typeof payload.sha256 === "string" ? payload.sha256 : "",
  };
  if (
    chunk.transferId !== manifest.transferId ||
    chunk.index >= manifest.chunkCount ||
    chunk.offset !== chunk.index * manifest.chunkBytes ||
    chunk.plaintextBytes !== expectedChunkLength(manifest, chunk.index) ||
    !sha256.test(chunk.sha256)
  ) {
    throw new CompanionReceiverError(
      "INVALID_CHUNK_BOUNDS",
      "chunk header is invalid",
    );
  }
  return chunk;
}

function validateIdentity(
  identity: Awaited<ReturnType<CompanionIdentityPort["ensureIdentity"]>>,
) {
  return {
    deviceId: requireIdentifier(identity.deviceId, "deviceId"),
    deviceName: requireText(identity.deviceName, 80, "deviceName"),
    fingerprint: requireFingerprint(identity.fingerprint),
  };
}

function validateResolvedInvite(
  value: CompanionResolvedPairingInvite,
  identity: { deviceId: string; deviceName: string; fingerprint: string },
  nowMs: number,
): CompanionResolvedPairingInvite {
  if (
    !Buffer.isBuffer(value.temporaryCredential) ||
    value.temporaryCredential.length !== 32 ||
    !Buffer.isBuffer(value.responderEphemeralPublicKey) ||
    value.responderEphemeralPublicKey.length !== 32 ||
    !Buffer.isBuffer(value.responderIdentityPublicKey) ||
    value.responderIdentityPublicKey.length !== 32 ||
    companionFingerprint(value.responderIdentityPublicKey) !==
      identity.fingerprint ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs < nowMs ||
    value.expiresAtMs > nowMs + 120_000
  ) {
    value.temporaryCredential?.fill(0);
    throw new CompanionReceiverError(
      "INVALID_PAIRING_INVITE",
      "resolved pairing invite is invalid",
    );
  }
  return {
    temporaryCredential: value.temporaryCredential,
    responderEphemeralPublicKey: Buffer.from(value.responderEphemeralPublicKey),
    responderIdentityPublicKey: Buffer.from(value.responderIdentityPublicKey),
    expiresAtMs: value.expiresAtMs,
  };
}

function parsePairingTranscript(
  value: unknown,
): CompanionPairingTranscriptValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionReceiverError(
      "INVALID_PAIRING_TRANSCRIPT",
      "pairing transcript must be an object",
    );
  }
  const transcript = value as Record<string, unknown>;
  exactKeys(transcript, [
    "schema",
    "pairingId",
    "initiatorDeviceId",
    "initiatorFingerprint",
    "initiatorEphemeralPublicKey",
    "responderDeviceId",
    "responderFingerprint",
    "responderEphemeralPublicKey",
    "shortCodeHash",
    "expiresAtMs",
    "capabilities",
  ]);
  const capabilities = transcript.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length !== 1 ||
    capabilities[0] !== "media-transfer/v1"
  ) {
    throw new CompanionReceiverError(
      "INVALID_PAIRING_TRANSCRIPT",
      "pairing capabilities are invalid",
    );
  }
  return {
    schema:
      transcript.schema === companionProtocol
        ? companionProtocol
        : (() => {
            throw new CompanionReceiverError(
              "INVALID_PAIRING_TRANSCRIPT",
              "pairing schema is invalid",
            );
          })(),
    pairingId: requireIdentifier(transcript.pairingId, "pairingId"),
    initiatorDeviceId: requireIdentifier(
      transcript.initiatorDeviceId,
      "initiatorDeviceId",
    ),
    initiatorFingerprint: requireFingerprint(transcript.initiatorFingerprint),
    initiatorEphemeralPublicKey: requireCanonicalBase64Text(
      transcript.initiatorEphemeralPublicKey,
      "initiatorEphemeralPublicKey",
    ),
    responderDeviceId: requireIdentifier(
      transcript.responderDeviceId,
      "responderDeviceId",
    ),
    responderFingerprint: requireFingerprint(transcript.responderFingerprint),
    responderEphemeralPublicKey: requireCanonicalBase64Text(
      transcript.responderEphemeralPublicKey,
      "responderEphemeralPublicKey",
    ),
    shortCodeHash: requireSha256(transcript.shortCodeHash, "shortCodeHash"),
    expiresAtMs: requireInteger(transcript.expiresAtMs, "expiresAtMs"),
    capabilities: ["media-transfer/v1"],
  };
}

function requireCanonicalBase64Text(value: unknown, field: string): string {
  const bytes = decodeCanonicalBase64(value, 32, field);
  bytes.fill(0);
  return String(value);
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !sha256.test(value)) {
    throw new CompanionReceiverError("INVALID_SHA256", `${field} is invalid`);
  }
  return value;
}

function requirePairingCode(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) {
    throw new CompanionReceiverError(
      "INVALID_SHORT_CODE",
      "pairing short code is invalid",
    );
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !identifier.test(value)) {
    throw new CompanionReceiverError(
      "INVALID_IDENTIFIER",
      `${field} is invalid`,
    );
  }
  return value;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !fingerprint.test(value)) {
    throw new CompanionReceiverError(
      "INVALID_FINGERPRINT",
      "fingerprint is invalid",
    );
  }
  return value;
}

function requireText(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > maximum ||
    Array.from(value).some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw new CompanionReceiverError("INVALID_TEXT", `${field} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CompanionReceiverError("INVALID_INTEGER", `${field} is invalid`);
  }
  return Number(value);
}

function expectedChunkLength(
  manifest: CompanionTransferManifest,
  index: number,
): number {
  if (index < 0 || index >= manifest.chunkCount) {
    throw new CompanionReceiverError(
      "INVALID_CHUNK_INDEX",
      "chunk index is invalid",
    );
  }
  return index < manifest.chunkCount - 1
    ? manifest.chunkBytes
    : manifest.sizeBytes - manifest.chunkBytes * (manifest.chunkCount - 1);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new CompanionReceiverError(
      "INVALID_FIELDS",
      "missing or unknown fields",
    );
  }
}

function parseObject(encoded: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new CompanionReceiverError("INVALID_JSON", "JSON is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionReceiverError("INVALID_JSON", "JSON object required");
  }
  return value as Record<string, unknown>;
}
