import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

import {
  companionCapability,
  companionProtocol,
  companionPairingInviteSchema,
  companionSnapshotSchema,
  companionTransferManifestSchema,
  companionTransferReceiptSchema,
  type CompanionPairingInvite,
  type CompanionSnapshot,
  type CompanionTransferManifest,
  type CompanionTransferReceipt,
} from "../../../shared/contracts";
import { TransferRepository } from "../../storage/repositories/transfer_repository";
import {
  canonicalCompanionPairingTranscript,
  companionFingerprint,
  companionX25519Secret,
  decodeCanonicalBase64,
  deriveCompanionPairingCredential,
  generateCompanionX25519KeyPair,
  verifyCompanionPairingSignature,
  type CompanionPairingTranscriptValue,
  type CompanionX25519KeyPair,
} from "./companion_crypto";

export type CompanionCredentialRequest =
  { kind: "identity-seed" } | { kind: "peer-shared"; peerDeviceId: string };

export interface CompanionNativeSecurityPort {
  readCredential(
    request: CompanionCredentialRequest,
  ): Promise<
    | { state: "available"; credential: Uint8Array }
    | { state: "missing" | "denied" | "corrupt" }
  >;
  replaceCredential(
    request: CompanionCredentialRequest,
    credential: Uint8Array,
  ): Promise<"stored">;
  deleteCredential(
    request: CompanionCredentialRequest,
  ): Promise<"deleted" | "missing" | "denied">;
}

export interface CompanionDiscoveryPort {
  register(request: {
    userInitiated: true;
    port: number;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
  }): Promise<{
    state:
      "registered" | "permission-denied" | "permission-pending" | "unavailable";
    manualFallbackAvailable: boolean;
    systemName?: string;
  }>;
  status?(): Promise<{
    state:
      "registered" | "permission-denied" | "permission-pending" | "unavailable";
    manualFallbackAvailable: boolean;
    systemName?: string;
  }>;
  unregister(): Promise<void>;
}

export interface CompanionReceiverPort {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  cancelTransfer(transferId: string): void;
  revokePeer(deviceId: string): void;
  cleanupPendingStaging(): number;
}

export interface CompanionIdentityPort {
  ensureIdentity(): Promise<{
    deviceId: string;
    deviceName: string;
    fingerprint: string;
  }>;
  identityPublicKey(): Promise<Buffer>;
  signBytes(payload: Uint8Array): Promise<Buffer>;
  signReceipt(
    unsignedReceipt: Readonly<Record<string, unknown>>,
  ): Promise<string>;
}

export interface CompanionImportCommitPort {
  commitVerifiedTransfer(
    stagedSourcePath: string,
    manifest: CompanionTransferManifest,
  ): Promise<{
    audioId: number;
    jobId: number;
    recordingId: number;
    sourceSha256: string;
  }>;
}

type PairingState = CompanionSnapshot["pairing"]["state"];
type DiscoveryState = CompanionSnapshot["discovery"]["state"];

export class CompanionService {
  private discoveryState: DiscoveryState = "disabled";
  private discoveryErrorCode: string | null = null;
  private manualFallbackAvailable = true;
  private identity: CompanionSnapshot["identity"] = null;
  private identityPublicKey: Buffer | null = null;
  private pairingState: PairingState = "idle";
  private pairingErrorCode: string | null = null;
  private pairingInvite: CompanionPairingInvite | null = null;
  private pendingPairingKeyPair: CompanionX25519KeyPair | null = null;
  private preparedPairing: {
    canonicalTranscript: Buffer;
    transcriptHash: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    transcript: CompanionPairingTranscriptValue;
    responderIdentityPublicKey: Buffer;
    responderSignature: Buffer;
  } | null = null;
  private completedPairing: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    canonicalTranscript: Buffer;
    transcriptHash: string;
  } | null = null;
  private pairingAttempts = 0;
  private receiverPort: number | null = null;
  private runtimeRevision = 0;
  private discoveryPollGeneration = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly runtimeCredentialUnavailable = new Set<string>();
  private readonly listeners = new Set<(snapshot: CompanionSnapshot) => void>();

  constructor(
    private readonly repository: TransferRepository,
    private readonly security: CompanionNativeSecurityPort,
    private readonly discovery: CompanionDiscoveryPort,
    private readonly receiver: CompanionReceiverPort,
    private readonly identityPort: CompanionIdentityPort,
    private readonly importCommit: CompanionImportCommitPort,
    private readonly nowMs: () => number = Date.now,
    private readonly waitForDiscoveryPoll: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 250)),
    private readonly resolveManualHost: () => string | null = privateLanAddress,
  ) {}

  async reconcileStartup(): Promise<CompanionSnapshot> {
    return await this.serializeLifecycle(async () => {
      this.repository.reconcileInterrupted(this.nowMs());
      this.repository.expireStaleCheckpoints(this.nowMs());
      this.receiver.cleanupPendingStaging();
      for (const peer of this.repository.listPeers()) {
        if (peer.trustState === "revoked") {
          this.runtimeCredentialUnavailable.delete(peer.deviceId);
          continue;
        }
        const credential = await this.security.readCredential({
          kind: "peer-shared",
          peerDeviceId: peer.deviceId,
        });
        if (credential.state === "available") {
          const available =
            createHash("sha256").update(credential.credential).digest("hex") ===
            this.repository.peerCredentialIdentity(peer.deviceId);
          credential.credential.fill(0);
          this.repository.markPeerCredentialAvailable(peer.deviceId, available);
          if (available) {
            this.runtimeCredentialUnavailable.delete(peer.deviceId);
          } else {
            this.runtimeCredentialUnavailable.add(peer.deviceId);
          }
        } else {
          this.runtimeCredentialUnavailable.add(peer.deviceId);
          if (credential.state !== "denied") {
            this.repository.markPeerCredentialAvailable(peer.deviceId, false);
          }
        }
      }
      const settings = this.repository.receiverSettings();
      this.discoveryState = settings.enabled ? "idle" : "disabled";
      return settings.enabled ? await this.startReceiver() : this.snapshot();
    });
  }

  onSnapshot(listener: (snapshot: CompanionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setOptIn(
    enabled: boolean,
    idempotencyKey?: string,
  ): Promise<CompanionSnapshot> {
    return await this.serializeLifecycle(
      async () => await this.setOptInInternal(enabled, idempotencyKey),
    );
  }

  private async setOptInInternal(
    enabled: boolean,
    idempotencyKey?: string,
  ): Promise<CompanionSnapshot> {
    const replay = this.replayCommand(
      idempotencyKey,
      "set-opt-in",
      String(enabled),
      null,
    );
    if (replay) return replay;
    const current = this.repository.receiverSettings();
    if (current.enabled === enabled) {
      const result =
        enabled && this.discoveryState !== "ready"
          ? await this.startReceiver()
          : this.snapshot();
      this.saveCommand(
        idempotencyKey,
        "set-opt-in",
        String(enabled),
        null,
        result,
      );
      return result;
    }
    if (!enabled) {
      await this.stopReceiver();
      this.repository.setReceiverEnabled(false, this.nowMs(), idempotencyKey);
      this.discoveryState = "disabled";
      this.identity = null;
      const result = this.publish();
      this.saveCommand(
        idempotencyKey,
        "set-opt-in",
        String(enabled),
        null,
        result,
      );
      return result;
    }
    this.repository.setReceiverEnabled(true, this.nowMs(), idempotencyKey);
    const result = await this.startReceiver();
    this.saveCommand(
      idempotencyKey,
      "set-opt-in",
      String(enabled),
      null,
      result,
    );
    return result;
  }

  private async startReceiver(): Promise<CompanionSnapshot> {
    this.discoveryState = "starting";
    this.publish();
    try {
      const identity = await this.identityPort.ensureIdentity();
      const identityPublicKey = await this.identityPort.identityPublicKey();
      if (companionFingerprint(identityPublicKey) !== identity.fingerprint) {
        identityPublicKey.fill(0);
        throw new Error("COMPANION_IDENTITY_FINGERPRINT_MISMATCH");
      }
      const listening = await this.receiver.start();
      this.receiverPort = listening.port;
      const registration = await this.discovery.register({
        userInitiated: true,
        port: listening.port,
        ...identity,
      });
      this.identity = { ...identity, port: listening.port };
      this.identityPublicKey = identityPublicKey;
      this.manualFallbackAvailable =
        registration.manualFallbackAvailable &&
        this.resolveManualHost() !== null;
      this.discoveryState =
        registration.state === "registered" ? "ready" : registration.state;
      this.discoveryErrorCode =
        registration.state === "registered"
          ? null
          : `COMPANION_DISCOVERY_${registration.state.replaceAll("-", "_").toUpperCase()}`;
      if (registration.state === "permission-pending") {
        const generation = ++this.discoveryPollGeneration;
        void this.pollPendingDiscovery(generation);
      }
      return this.publish();
    } catch (error) {
      await this.stopReceiver();
      this.discoveryState = "error";
      this.discoveryErrorCode = boundedCode(
        error,
        "COMPANION_RECEIVER_UNAVAILABLE",
      );
      return this.publish();
    }
  }

  createPairingInvite(idempotencyKey?: string): CompanionSnapshot {
    const replay = this.replayCommand(
      idempotencyKey,
      "create-invite",
      "receiver",
      null,
    );
    if (replay) return replay;
    if (
      !this.repository.receiverSettings().enabled ||
      !this.identity ||
      !this.identityPublicKey
    ) {
      throw new Error("Companion receiver is not enabled");
    }
    const now = this.nowMs();
    const manualHost = this.resolveManualHost();
    if (!manualHost) {
      throw new Error("Companion manual endpoint is unavailable");
    }
    const pairingId = `pair-${now}-${randomBytes(8).toString("hex")}`;
    const shortCode = randomBytes(4).readUInt32BE(0) % 1_000_000;
    this.clearPairingSecret();
    this.clearCompletedPairing();
    const pairingKeyPair = generateCompanionX25519KeyPair();
    this.pendingPairingKeyPair = pairingKeyPair;
    this.pairingAttempts = 0;
    this.pairingInvite = companionPairingInviteSchema.parse({
      schema: companionProtocol,
      pairingId,
      shortCode: shortCode.toString().padStart(6, "0"),
      displayHandle: [
        pairingId,
        this.identity.deviceId,
        this.identity.fingerprint,
      ].join(":"),
      responderEphemeralPublicKey: pairingKeyPair.publicKey.toString("base64"),
      responderIdentityPublicKey: this.identityPublicKey.toString("base64"),
      manualEndpoint: {
        host: manualHost,
        port: this.identity.port,
      },
      expiresAtMs: now + 120_000,
    });
    this.pairingState = "awaiting-peer";
    this.pairingErrorCode = null;
    const result = this.publish();
    this.saveCommand(idempotencyKey, "create-invite", "receiver", null, result);
    return result;
  }

  async resolveInvite(input: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    initiatorEphemeralPublicKey: Buffer;
  }): Promise<{
    temporaryCredential: Buffer;
    responderEphemeralPublicKey: Buffer;
    responderIdentityPublicKey: Buffer;
    expiresAtMs: number;
  } | null> {
    void input.deviceId;
    void input.deviceName;
    void input.fingerprint;
    const keyPair = this.pendingPairingKeyPair;
    if (
      !this.pairingInvite ||
      !keyPair ||
      this.pairingInvite.pairingId !== input.pairingId ||
      this.nowMs() > this.pairingInvite.expiresAtMs ||
      this.pairingState === "locked" ||
      input.initiatorEphemeralPublicKey.length !== 32
    ) {
      return null;
    }
    const responderIdentityPublicKey =
      await this.identityPort.identityPublicKey();
    if (
      !this.identity ||
      companionFingerprint(responderIdentityPublicKey) !==
        this.identity.fingerprint
    ) {
      responderIdentityPublicKey.fill(0);
      throw new Error("COMPANION_IDENTITY_FINGERPRINT_MISMATCH");
    }
    const sharedSecret = companionX25519Secret(
      keyPair.privateKey,
      input.initiatorEphemeralPublicKey,
    );
    try {
      return {
        temporaryCredential: deriveCompanionPairingCredential(
          sharedSecret,
          input.pairingId,
          "temporary-channel",
        ),
        responderEphemeralPublicKey: Buffer.from(keyPair.publicKey),
        responderIdentityPublicKey,
        expiresAtMs: this.pairingInvite.expiresAtMs,
      };
    } finally {
      sharedSecret.fill(0);
    }
  }

  async confirmInvite(input: {
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
  }> {
    const invite = this.pairingInvite;
    const keyPair = this.pendingPairingKeyPair;
    if (this.pairingState === "locked") {
      throw new Error("COMPANION_PAIRING_LOCKED");
    }
    if (!invite || !keyPair || invite.pairingId !== input.pairingId) {
      throw new Error("COMPANION_PAIRING_NOT_FOUND");
    }
    if (this.nowMs() > invite.expiresAtMs) {
      this.clearPairingSecret();
      this.pairingState = "expired";
      this.pairingErrorCode = "COMPANION_PAIRING_EXPIRED";
      this.publish();
      throw new Error("COMPANION_PAIRING_EXPIRED");
    }
    if (!safeEqualText(invite.shortCode, input.shortCode)) {
      this.pairingAttempts += 1;
      if (this.pairingAttempts >= 5) {
        this.clearPairingSecret();
        this.pairingState = "locked";
        this.pairingErrorCode = "COMPANION_PAIRING_LOCKED";
      } else {
        this.pairingState = "code-mismatch";
        this.pairingErrorCode = "COMPANION_PAIRING_CODE_MISMATCH";
      }
      this.publish();
      throw new Error(this.pairingErrorCode);
    }
    const identity = this.identity;
    if (!identity) throw new Error("COMPANION_IDENTITY_UNAVAILABLE");
    const initiatorEphemeralPublicKey = decodeCanonicalBase64(
      input.transcript.initiatorEphemeralPublicKey,
      32,
      "initiatorEphemeralPublicKey",
    );
    const expectedTranscript: CompanionPairingTranscriptValue = {
      schema: companionProtocol,
      pairingId: invite.pairingId,
      initiatorDeviceId: input.deviceId,
      initiatorFingerprint: input.fingerprint,
      initiatorEphemeralPublicKey:
        initiatorEphemeralPublicKey.toString("base64"),
      responderDeviceId: identity.deviceId,
      responderFingerprint: identity.fingerprint,
      responderEphemeralPublicKey: keyPair.publicKey.toString("base64"),
      shortCodeHash: createHash("sha256")
        .update(`${invite.pairingId}:${invite.shortCode}`)
        .digest("hex"),
      expiresAtMs: invite.expiresAtMs,
      capabilities: [companionCapability],
    };
    const canonical = canonicalCompanionPairingTranscript(expectedTranscript);
    const presentedCanonical = canonicalCompanionPairingTranscript(
      input.transcript,
    );
    if (
      canonical.length !== presentedCanonical.length ||
      !timingSafeEqual(canonical, presentedCanonical)
    ) {
      throw new Error("COMPANION_PAIRING_TRANSCRIPT_MISMATCH");
    }
    verifyCompanionPairingSignature(
      expectedTranscript,
      input.initiatorIdentityPublicKey,
      input.initiatorSignature,
      input.fingerprint,
    );
    if (this.preparedPairing) {
      if (
        this.preparedPairing.canonicalTranscript.length !== canonical.length ||
        !timingSafeEqual(this.preparedPairing.canonicalTranscript, canonical) ||
        this.preparedPairing.deviceId !== input.deviceId ||
        this.preparedPairing.fingerprint !== input.fingerprint
      ) {
        throw new Error("COMPANION_PAIRING_ALREADY_PREPARED");
      }
      return {
        responderIdentityPublicKey: Buffer.from(
          this.preparedPairing.responderIdentityPublicKey,
        ),
        responderSignature: Buffer.from(
          this.preparedPairing.responderSignature,
        ),
      };
    }
    const responderIdentityPublicKey =
      await this.identityPort.identityPublicKey();
    if (
      companionFingerprint(responderIdentityPublicKey) !== identity.fingerprint
    ) {
      responderIdentityPublicKey.fill(0);
      throw new Error("COMPANION_IDENTITY_FINGERPRINT_MISMATCH");
    }
    try {
      const responderSignature = await this.identityPort.signBytes(canonical);
      this.preparedPairing = {
        canonicalTranscript: Buffer.from(canonical),
        transcriptHash: createHash("sha256").update(canonical).digest("hex"),
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        fingerprint: input.fingerprint,
        transcript: expectedTranscript,
        responderIdentityPublicKey: Buffer.from(responderIdentityPublicKey),
        responderSignature: Buffer.from(responderSignature),
      };
      return { responderIdentityPublicKey, responderSignature };
    } finally {
      initiatorEphemeralPublicKey.fill(0);
    }
  }

  async commitInvite(input: {
    pairingId: string;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    transcript: CompanionPairingTranscriptValue;
    transcriptHash: string;
  }): Promise<void> {
    const prepared = this.preparedPairing;
    const keyPair = this.pendingPairingKeyPair;
    const invite = this.pairingInvite;
    if (!prepared || !keyPair || !invite) {
      const completed = this.completedPairing;
      const canonical = canonicalCompanionPairingTranscript(input.transcript);
      const computedHash = createHash("sha256").update(canonical).digest("hex");
      if (
        completed?.pairingId === input.pairingId &&
        completed.deviceId === input.deviceId &&
        completed.deviceName === input.deviceName &&
        completed.fingerprint === input.fingerprint &&
        completed.transcriptHash === input.transcriptHash &&
        computedHash === input.transcriptHash &&
        canonical.length === completed.canonicalTranscript.length &&
        timingSafeEqual(canonical, completed.canonicalTranscript)
      ) {
        return;
      }
      throw new Error("COMPANION_PAIRING_COMMIT_NOT_PREPARED");
    }
    const canonical = canonicalCompanionPairingTranscript(input.transcript);
    const computedHash = createHash("sha256").update(canonical).digest("hex");
    if (
      input.pairingId !== prepared.transcript.pairingId ||
      input.deviceId !== prepared.deviceId ||
      input.deviceName !== prepared.deviceName ||
      input.fingerprint !== prepared.fingerprint ||
      input.transcriptHash !== computedHash ||
      input.transcriptHash !== prepared.transcriptHash ||
      canonical.length !== prepared.canonicalTranscript.length ||
      !timingSafeEqual(canonical, prepared.canonicalTranscript)
    ) {
      throw new Error("COMPANION_PAIRING_COMMIT_MISMATCH");
    }
    const initiatorEphemeralPublicKey = decodeCanonicalBase64(
      input.transcript.initiatorEphemeralPublicKey,
      32,
      "initiatorEphemeralPublicKey",
    );
    const sharedSecret = companionX25519Secret(
      keyPair.privateKey,
      initiatorEphemeralPublicKey,
    );
    const transcriptHashBytes = Buffer.from(computedHash, "hex");
    const credential = deriveCompanionPairingCredential(
      sharedSecret,
      input.pairingId,
      "long-term-peer",
      transcriptHashBytes,
    );
    try {
      const peer = {
        deviceId: input.deviceId,
        displayName: input.deviceName,
        identityFingerprint: input.fingerprint,
        credentialIdentitySha256: createHash("sha256")
          .update(credential)
          .digest("hex"),
        pairedAtMs: this.nowMs(),
      };
      this.repository.assertPeerPairingAllowed(peer);
      await this.security.replaceCredential(
        { kind: "peer-shared", peerDeviceId: input.deviceId },
        credential,
      );
      this.repository.pairPeer(peer);
      this.runtimeCredentialUnavailable.delete(input.deviceId);
      const completedPairing = {
        pairingId: input.pairingId,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        fingerprint: input.fingerprint,
        canonicalTranscript: Buffer.from(canonical),
        transcriptHash: computedHash,
      };
      this.clearPairingSecret();
      this.completedPairing = completedPairing;
      this.pairingState = "paired";
      this.pairingErrorCode = null;
      this.publish();
    } finally {
      initiatorEphemeralPublicKey.fill(0);
      sharedSecret.fill(0);
      transcriptHashBytes.fill(0);
      credential.fill(0);
    }
  }

  async revokePeer(
    deviceId: string,
    idempotencyKey?: string,
  ): Promise<CompanionSnapshot> {
    const replay = this.replayCommand(
      idempotencyKey,
      "revoke-peer",
      deviceId,
      null,
    );
    if (replay) {
      this.receiver.revokePeer(deviceId);
      return replay;
    }
    await this.security.deleteCredential({
      kind: "peer-shared",
      peerDeviceId: deviceId,
    });
    this.repository.revokePeer(deviceId, this.nowMs(), idempotencyKey);
    this.runtimeCredentialUnavailable.delete(deviceId);
    this.receiver.revokePeer(deviceId);
    const result = this.publish();
    this.saveCommand(idempotencyKey, "revoke-peer", deviceId, null, result);
    return result;
  }

  cancelTransfer(
    transferId: string,
    expectedRevision: number,
    idempotencyKey?: string,
  ): CompanionSnapshot {
    const replay = this.replayCommand(
      idempotencyKey,
      "cancel-transfer",
      transferId,
      expectedRevision,
    );
    if (replay) {
      this.receiver.cancelTransfer(transferId);
      return replay;
    }
    this.repository.cancelTransfer(
      transferId,
      expectedRevision,
      this.nowMs(),
      idempotencyKey,
    );
    this.receiver.cancelTransfer(transferId);
    const result = this.publish();
    this.saveCommand(
      idempotencyKey,
      "cancel-transfer",
      transferId,
      expectedRevision,
      result,
    );
    return result;
  }

  retryTransfer(
    transferId: string,
    expectedRevision: number,
    idempotencyKey?: string,
  ): CompanionSnapshot {
    const replay = this.replayCommand(
      idempotencyKey,
      "retry-transfer",
      transferId,
      expectedRevision,
    );
    if (replay) return replay;
    this.repository.retryTransfer(
      transferId,
      expectedRevision,
      this.nowMs(),
      idempotencyKey,
    );
    const result = this.publish();
    this.saveCommand(
      idempotencyKey,
      "retry-transfer",
      transferId,
      expectedRevision,
      result,
    );
    return result;
  }

  async commitTransfer(
    manifestInput: CompanionTransferManifest,
    stagedSourcePath: string,
  ): Promise<CompanionTransferReceipt> {
    const manifest = companionTransferManifestSchema.parse(manifestInput);
    const prior = this.repository.getTransfer(manifest.transferId)?.receipt;
    if (prior) return prior;
    const committed = await this.importCommit.commitVerifiedTransfer(
      stagedSourcePath,
      manifest,
    );
    if (committed.sourceSha256 !== manifest.wholeFileSha256) {
      throw new Error(
        "secure import source hash does not match companion manifest",
      );
    }
    const unsigned = {
      schema: companionProtocol,
      receiptId: `receipt-${manifest.transferId}`,
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      sizeBytes: manifest.sizeBytes,
      desktopDeviceId: this.identity?.deviceId ?? "desktop-unavailable",
      desktopDeviceName: this.identity?.deviceName ?? "Voice2Text Mac",
      desktopRecordingId: committed.recordingId,
      committedAtMs: this.nowMs(),
    };
    const receipt = companionTransferReceiptSchema.parse({
      ...unsigned,
      signature: await this.identityPort.signReceipt(unsigned),
    });
    this.repository.recordCommittedReceipt(manifest, receipt, {
      audioId: committed.audioId,
      processingJobId: committed.jobId,
      recordingId: committed.recordingId,
      sourceSha256: committed.sourceSha256,
    });
    this.publish();
    return receipt;
  }

  snapshot(): CompanionSnapshot {
    const settings = this.repository.receiverSettings();
    const transfers = this.repository.listTransfers().map((transfer) => ({
      transferId: transfer.transferId,
      displayName: transfer.displayName,
      wholeFileSha256: transfer.wholeFileSha256,
      sizeBytes: transfer.sizeBytes,
      receivedBytes: transfer.receivedBytes,
      missingChunkCount: transfer.missingChunkCount,
      state: transfer.state,
      revision: transfer.revision,
      errorCode: transfer.errorCode,
      receipt: transfer.receipt,
      senderDeleteAllowed: transfer.senderDeleteAllowed,
      updatedAtMs: transfer.updatedAtMs,
    }));
    return companionSnapshotSchema.parse({
      protocolVersion: 2,
      revision:
        settings.revision +
        this.runtimeRevision +
        transfers.reduce((sum, transfer) => sum + transfer.revision, 0),
      optIn: settings.enabled,
      discovery: {
        state: settings.enabled ? this.discoveryState : "disabled",
        manualFallbackAvailable: this.manualFallbackAvailable,
        errorCode: this.discoveryErrorCode,
      },
      pairing: { state: this.pairingState, errorCode: this.pairingErrorCode },
      identity: settings.enabled ? this.identity : null,
      pairingInvite: this.pairingInvite,
      peers: this.repository.listPeers().map((peer) => ({
        ...peer,
        trustState:
          peer.trustState !== "revoked" &&
          this.runtimeCredentialUnavailable.has(peer.deviceId)
            ? ("credential-missing" as const)
            : peer.trustState,
        availability: "unknown" as const,
      })),
      transfers,
    });
  }

  notifyTransferChanged(): CompanionSnapshot {
    return this.publish();
  }

  async close(): Promise<void> {
    await this.serializeLifecycle(async () => {
      this.clearPairingSecret();
      this.clearCompletedPairing();
      await this.stopReceiver();
    });
  }

  private async stopReceiver(): Promise<void> {
    this.discoveryPollGeneration += 1;
    try {
      await this.discovery.unregister();
    } finally {
      await this.receiver.stop();
      this.receiverPort = null;
      this.identityPublicKey = null;
    }
  }

  private async pollPendingDiscovery(generation: number): Promise<void> {
    const status = this.discovery.status;
    if (!status) return;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await this.waitForDiscoveryPoll();
      if (
        generation !== this.discoveryPollGeneration ||
        !this.repository.receiverSettings().enabled
      ) {
        return;
      }
      try {
        const receipt = await status.call(this.discovery);
        if (
          generation !== this.discoveryPollGeneration ||
          !this.repository.receiverSettings().enabled
        ) {
          return;
        }
        this.manualFallbackAvailable =
          receipt.manualFallbackAvailable && this.resolveManualHost() !== null;
        this.discoveryState =
          receipt.state === "registered" ? "ready" : receipt.state;
        this.discoveryErrorCode =
          receipt.state === "registered"
            ? null
            : `COMPANION_DISCOVERY_${receipt.state.replaceAll("-", "_").toUpperCase()}`;
        this.publish();
        if (receipt.state !== "permission-pending") return;
      } catch (error) {
        this.discoveryState = "error";
        this.discoveryErrorCode = boundedCode(
          error,
          "COMPANION_DISCOVERY_STATUS_FAILED",
        );
        this.publish();
        return;
      }
    }
    if (generation === this.discoveryPollGeneration) {
      this.discoveryState = "unavailable";
      this.discoveryErrorCode = "COMPANION_DISCOVERY_STATUS_TIMEOUT";
      this.publish();
    }
  }

  private clearPairingSecret(): void {
    this.pendingPairingKeyPair?.destroy();
    this.pendingPairingKeyPair = null;
    this.preparedPairing?.canonicalTranscript.fill(0);
    this.preparedPairing?.responderIdentityPublicKey.fill(0);
    this.preparedPairing?.responderSignature.fill(0);
    this.preparedPairing = null;
    this.pairingInvite = null;
    this.pairingAttempts = 0;
  }

  private clearCompletedPairing(): void {
    this.completedPairing?.canonicalTranscript.fill(0);
    this.completedPairing = null;
  }

  private publish(): CompanionSnapshot {
    this.runtimeRevision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  private replayCommand(
    idempotencyKey: string | undefined,
    action: Parameters<TransferRepository["recordCommandReceipt"]>[0]["action"],
    targetIdentity: string,
    expectedRevision: number | null,
  ): CompanionSnapshot | null {
    if (!idempotencyKey) return null;
    const receipt = this.repository.commandReceipt(idempotencyKey);
    if (!receipt) return null;
    if (
      receipt.action !== action ||
      receipt.targetIdentity !== targetIdentity ||
      receipt.expectedRevision !== expectedRevision
    ) {
      throw new Error("COMPANION_COMMAND_CONFLICT");
    }
    return this.snapshot();
  }

  private saveCommand(
    idempotencyKey: string | undefined,
    action: Parameters<TransferRepository["recordCommandReceipt"]>[0]["action"],
    targetIdentity: string,
    expectedRevision: number | null,
    result: CompanionSnapshot,
  ): void {
    if (!idempotencyKey) return;
    this.repository.recordCommandReceipt({
      idempotencyKey,
      action,
      targetIdentity,
      expectedRevision,
      resultRevision: result.revision,
      nowMs: this.nowMs(),
    });
  }

  private async serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.catch(() => undefined).then(operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function boundedCode(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/.test(code)
    ? code
    : fallback;
}

function safeEqualText(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  return (
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}

function privateLanAddress(): string | null {
  return selectPrivateLanAddress(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter(
        (entry) =>
          entry.family === "IPv4" &&
          !entry.internal &&
          !entry.address.startsWith("169.254.") &&
          entry.address !== "0.0.0.0",
      )
      .map((entry) => entry.address),
  );
}

export function selectPrivateLanAddress(
  addresses: readonly string[],
): string | null {
  const eligible = addresses.filter((address) => {
    const octets = address.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet, index) =>
          !Number.isInteger(octet) ||
          octet < 0 ||
          octet > 255 ||
          String(octet) !== address.split(".")[index],
      )
    ) {
      return false;
    }
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  });
  return eligible.sort()[0] ?? null;
}
