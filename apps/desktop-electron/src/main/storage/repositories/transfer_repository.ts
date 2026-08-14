import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  companionLimits,
  companionTransferManifestSchema,
  companionTransferReceiptSchema,
  type CompanionTransferManifest,
  type CompanionTransferReceipt,
} from "../../../shared/contracts";
import { withTransaction } from "../database";

export class CompanionTransferFailure extends Error {
  constructor(
    readonly code:
      | "COMPANION_TRANSFER_CONFLICT"
      | "COMPANION_CHUNK_CONFLICT"
      | "COMPANION_CHECKPOINT_EXPIRED"
      | "COMPANION_TRANSFER_NOT_FOUND"
      | "COMPANION_RECEIPT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "CompanionTransferFailure";
  }
}

export interface CompanionTransferRecord {
  transferId: string;
  wholeFileSha256: string;
  peerDeviceId: string;
  displayName: string;
  sizeBytes: number;
  chunkBytes: number;
  chunkCount: number;
  state:
    | "awaiting"
    | "transferring"
    | "verifying"
    | "importing"
    | "committed"
    | "canceled"
    | "failed"
    | "interrupted"
    | "expired";
  revision: number;
  errorCode: string | null;
  receivedBytes: number;
  missingChunkCount: number;
  receipt: CompanionTransferReceipt | null;
  senderDeleteAllowed: boolean;
  destinationIdentity: string | null;
  importStartedAtMs: number | null;
  stagingCleanupState: "active" | "pending" | "complete";
  updatedAtMs: number;
}

export class TransferRepository {
  constructor(private readonly database: DatabaseSync) {}

  pairPeer(peer: {
    deviceId: string;
    displayName: string;
    identityFingerprint: string;
    credentialIdentitySha256: string;
    pairedAtMs: number;
  }): void {
    this.assertPeerPairingAllowed(peer);
    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO companion_peers (
          device_id, display_name, identity_fingerprint, credential_identity_sha256,
          trust_state, paired_at_ms, last_seen_at_ms, revoked_at_ms
        ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          display_name = excluded.display_name,
          identity_fingerprint = excluded.identity_fingerprint,
          credential_identity_sha256 = excluded.credential_identity_sha256,
          trust_state = 'active', paired_at_ms = excluded.paired_at_ms, revoked_at_ms = NULL`,
        )
        .run(
          peer.deviceId,
          peer.displayName.trim(),
          peer.identityFingerprint,
          peer.credentialIdentitySha256,
          peer.pairedAtMs,
        );
      this.bumpRevision(peer.pairedAtMs);
    });
  }

  assertPeerPairingAllowed(peer: {
    deviceId: string;
    displayName: string;
    identityFingerprint: string;
    credentialIdentitySha256: string;
    pairedAtMs: number;
  }): void {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(peer.deviceId) ||
      peer.displayName.trim().length < 1 ||
      [...peer.displayName.trim()].length > 80 ||
      !/^[A-Z2-7]{20,64}$/.test(peer.identityFingerprint) ||
      !/^[a-f0-9]{64}$/.test(peer.credentialIdentitySha256) ||
      !Number.isSafeInteger(peer.pairedAtMs) ||
      peer.pairedAtMs < 0
    ) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_CONFLICT",
        "peer trust identity is invalid",
      );
    }
    const existing = this.database
      .prepare(
        `SELECT identity_fingerprint, credential_identity_sha256, trust_state
         FROM companion_peers WHERE device_id = ?`,
      )
      .get(peer.deviceId);
    if (
      existing &&
      existing.trust_state !== "revoked" &&
      (existing.identity_fingerprint !== peer.identityFingerprint ||
        existing.credential_identity_sha256 !== peer.credentialIdentitySha256)
    ) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_CONFLICT",
        "active peer trust cannot be replaced with different credentials",
      );
    }
  }

  receiverSettings(): { enabled: boolean; revision: number } {
    const row = this.database
      .prepare(
        "SELECT receiver_enabled, revision FROM companion_settings WHERE id = 1",
      )
      .get()!;
    return {
      enabled: Number(row.receiver_enabled) === 1,
      revision: Number(row.revision),
    };
  }

  commandReceipt(idempotencyKey: string): {
    action:
      | "set-opt-in"
      | "create-invite"
      | "revoke-peer"
      | "cancel-transfer"
      | "retry-transfer";
    targetIdentity: string;
    expectedRevision: number | null;
    resultRevision: number;
  } | null {
    const row = this.database
      .prepare(
        `SELECT action, target_identity, expected_revision, result_revision
         FROM companion_command_receipts WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    return row
      ? {
          action: String(row.action) as
            | "set-opt-in"
            | "create-invite"
            | "revoke-peer"
            | "cancel-transfer"
            | "retry-transfer",
          targetIdentity: String(row.target_identity),
          expectedRevision:
            row.expected_revision === null
              ? null
              : Number(row.expected_revision),
          resultRevision: Number(row.result_revision),
        }
      : null;
  }

  recordCommandReceipt(command: {
    idempotencyKey: string;
    action:
      | "set-opt-in"
      | "create-invite"
      | "revoke-peer"
      | "cancel-transfer"
      | "retry-transfer";
    targetIdentity: string;
    expectedRevision: number | null;
    resultRevision: number;
    nowMs: number;
  }): void {
    const existing = this.commandReceipt(command.idempotencyKey);
    if (existing) {
      if (
        existing.action !== command.action ||
        existing.targetIdentity !== command.targetIdentity ||
        existing.expectedRevision !== command.expectedRevision
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "companion command receipt identity changed",
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO companion_command_receipts (
          idempotency_key, action, target_identity, expected_revision,
          result_revision, result_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.idempotencyKey,
        command.action,
        command.targetIdentity,
        command.expectedRevision,
        command.resultRevision,
        JSON.stringify({
          protocolVersion: 1,
          revision: command.resultRevision,
        }),
        command.nowMs,
      );
  }

  setReceiverEnabled(
    enabled: boolean,
    nowMs = Date.now(),
    idempotencyKey?: string,
  ): { enabled: boolean; revision: number } {
    return withTransaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE companion_settings SET receiver_enabled = ?, revision = revision + 1,
           updated_at_ms = ? WHERE id = 1 AND receiver_enabled != ?`,
        )
        .run(enabled ? 1 : 0, nowMs, enabled ? 1 : 0);
      const result = this.receiverSettings();
      if (idempotencyKey) {
        this.recordCommandReceipt({
          idempotencyKey,
          action: "set-opt-in",
          targetIdentity: String(enabled),
          expectedRevision: null,
          resultRevision: result.revision,
          nowMs,
        });
      }
      return result;
    });
  }

  listPeers(): Array<{
    deviceId: string;
    displayName: string;
    identityFingerprint: string;
    trustState: "active" | "revoked" | "credential-missing";
    pairedAtMs: number;
    lastSeenAtMs: number | null;
  }> {
    return this.database
      .prepare(
        `SELECT device_id, display_name, identity_fingerprint, trust_state,
         paired_at_ms, last_seen_at_ms FROM companion_peers
         ORDER BY paired_at_ms DESC, device_id LIMIT 256`,
      )
      .all()
      .map((row) => ({
        deviceId: String(row.device_id),
        displayName: String(row.display_name),
        identityFingerprint: String(row.identity_fingerprint),
        trustState: String(row.trust_state) as
          "active" | "revoked" | "credential-missing",
        pairedAtMs: Number(row.paired_at_ms),
        lastSeenAtMs:
          row.last_seen_at_ms === null ? null : Number(row.last_seen_at_ms),
      }));
  }

  peer(deviceId: string) {
    return this.listPeers().find((peer) => peer.deviceId === deviceId) ?? null;
  }

  peerCredentialIdentity(deviceId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT credential_identity_sha256 FROM companion_peers
         WHERE device_id = ? AND trust_state != 'revoked'`,
      )
      .get(deviceId);
    return row ? String(row.credential_identity_sha256) : null;
  }

  markPeerCredentialAvailable(deviceId: string, available: boolean): void {
    this.database
      .prepare(
        `UPDATE companion_peers SET trust_state = ?
         WHERE device_id = ? AND trust_state != 'revoked'`,
      )
      .run(available ? "active" : "credential-missing", deviceId);
  }

  verifiedChunks(transferId: string): Array<{
    index: number;
    offset: number;
    sha256: string;
    plaintextBytes: number;
  }> {
    return this.database
      .prepare(
        `SELECT chunk_index, chunk_offset, chunk_sha256, plaintext_bytes
         FROM companion_transfer_chunks WHERE transfer_id = ? ORDER BY chunk_index`,
      )
      .all(transferId)
      .map((row) => ({
        index: Number(row.chunk_index),
        offset: Number(row.chunk_offset),
        sha256: String(row.chunk_sha256),
        plaintextBytes: Number(row.plaintext_bytes),
      }));
  }

  revokePeer(
    deviceId: string,
    nowMs = Date.now(),
    idempotencyKey?: string,
  ): void {
    withTransaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE companion_peers SET trust_state = 'revoked', revoked_at_ms = ?
           WHERE device_id = ?`,
        )
        .run(nowMs, deviceId);
      this.bumpRevision(nowMs);
      this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'canceled', revision = revision + 1,
           error_code = 'COMPANION_PEER_REVOKED', sender_delete_allowed = 0,
           receipt_json = NULL, staging_cleanup_state = 'pending', updated_at_ms = ?
           WHERE peer_device_id = ? AND state != 'committed'`,
        )
        .run(nowMs, deviceId);
      if (idempotencyKey) {
        this.recordCommandReceipt({
          idempotencyKey,
          action: "revoke-peer",
          targetIdentity: deviceId,
          expectedRevision: null,
          resultRevision: this.receiverSettings().revision,
          nowMs,
        });
      }
    });
  }

  cancelTransfer(
    transferId: string,
    expectedRevision: number,
    nowMs = Date.now(),
    idempotencyKey?: string,
  ): CompanionTransferRecord {
    return withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'canceled', revision = revision + 1,
         error_code = NULL, staging_cleanup_state = 'pending', updated_at_ms = ?
         WHERE transfer_id = ? AND revision = ?
           AND state NOT IN ('committed', 'canceled', 'expired')`,
        )
        .run(nowMs, transferId, expectedRevision);
      if (Number(result.changes) !== 1) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "transfer cancellation lost its revision fence",
        );
      }
      const transfer = this.requireTransfer(transferId);
      if (idempotencyKey) {
        this.recordCommandReceipt({
          idempotencyKey,
          action: "cancel-transfer",
          targetIdentity: transferId,
          expectedRevision,
          resultRevision: transfer.revision,
          nowMs,
        });
      }
      return transfer;
    });
  }

  retryTransfer(
    transferId: string,
    expectedRevision: number,
    nowMs = Date.now(),
    idempotencyKey?: string,
  ): CompanionTransferRecord {
    return withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'interrupted', revision = revision + 1,
         error_code = NULL, checkpoint_expires_at_ms = ?, updated_at_ms = ?
         WHERE transfer_id = ? AND revision = ? AND state IN ('failed', 'interrupted')`,
        )
        .run(
          nowMs + companionLimits.checkpointLifetimeMs,
          nowMs,
          transferId,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "transfer retry lost its revision fence",
        );
      }
      const transfer = this.requireTransfer(transferId);
      if (idempotencyKey) {
        this.recordCommandReceipt({
          idempotencyKey,
          action: "retry-transfer",
          targetIdentity: transferId,
          expectedRevision,
          resultRevision: transfer.revision,
          nowMs,
        });
      }
      return transfer;
    });
  }

  reconcileInterrupted(nowMs = Date.now()): number {
    return Number(
      this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'interrupted', revision = revision + 1,
           error_code = 'COMPANION_TRANSFER_INTERRUPTED', updated_at_ms = ?
           WHERE state IN ('awaiting', 'transferring', 'verifying', 'importing')`,
        )
        .run(nowMs).changes,
    );
  }

  interruptTransfer(
    transferId: string,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    this.database
      .prepare(
        `UPDATE companion_transfers SET state = 'interrupted', revision = revision + 1,
         error_code = 'COMPANION_TRANSFER_INTERRUPTED', updated_at_ms = ?
         WHERE transfer_id = ? AND state IN ('awaiting', 'transferring', 'verifying', 'importing')`,
      )
      .run(nowMs, transferId);
    return this.requireTransfer(transferId);
  }

  beginTransfer(
    input: CompanionTransferManifest,
    peerDeviceId: string,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    const manifest = companionTransferManifestSchema.parse(input);
    const existing = this.getTransfer(manifest.transferId);
    if (existing) {
      if (
        existing.wholeFileSha256 !== manifest.wholeFileSha256 ||
        existing.peerDeviceId !== peerDeviceId ||
        existing.sizeBytes !== manifest.sizeBytes ||
        existing.chunkBytes !== manifest.chunkBytes ||
        existing.chunkCount !== manifest.chunkCount
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "transfer id is already bound to different content",
        );
      }
      if (
        existing.state !== "committed" &&
        nowMs > this.checkpointExpiry(manifest.transferId)
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_CHECKPOINT_EXPIRED",
          "transfer checkpoint expired",
        );
      }
      if (["canceled", "expired", "failed"].includes(existing.state)) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "terminal transfer requires an explicit retry or new transfer id",
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO companion_transfers (
          transfer_id, whole_file_sha256, peer_device_id, source_asset_id,
          display_name, size_bytes, chunk_bytes, chunk_count, state, revision,
          checkpoint_expires_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', 1, ?, ?, ?)`,
      )
      .run(
        manifest.transferId,
        manifest.wholeFileSha256,
        peerDeviceId,
        manifest.sourceAssetId,
        manifest.displayName,
        manifest.sizeBytes,
        manifest.chunkBytes,
        manifest.chunkCount,
        nowMs + companionLimits.checkpointLifetimeMs,
        nowMs,
        nowMs,
      );
    return this.requireTransfer(manifest.transferId);
  }

  recordVerifiedChunk(chunk: {
    transferId: string;
    wholeFileSha256: string;
    index: number;
    offset: number;
    plaintextBytes: number;
    sha256: string;
    receivedAtMs: number;
  }): CompanionTransferRecord {
    return withTransaction(this.database, () => {
      const transfer = this.requireTransfer(chunk.transferId);
      if (
        !["awaiting", "transferring", "interrupted"].includes(transfer.state) ||
        transfer.wholeFileSha256 !== chunk.wholeFileSha256 ||
        chunk.index < 0 ||
        chunk.index >= transfer.chunkCount ||
        chunk.offset !== chunk.index * transfer.chunkBytes ||
        chunk.plaintextBytes !== expectedChunkLength(transfer, chunk.index)
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_CHUNK_CONFLICT",
          "verified chunk does not match its durable manifest",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT whole_file_sha256, chunk_offset, chunk_sha256, plaintext_bytes
           FROM companion_transfer_chunks WHERE transfer_id = ? AND chunk_index = ?`,
        )
        .get(chunk.transferId, chunk.index);
      if (existing) {
        if (
          existing.whole_file_sha256 !== chunk.wholeFileSha256 ||
          existing.chunk_offset !== chunk.offset ||
          existing.chunk_sha256 !== chunk.sha256 ||
          existing.plaintext_bytes !== chunk.plaintextBytes
        ) {
          throw new CompanionTransferFailure(
            "COMPANION_CHUNK_CONFLICT",
            "chunk index is already bound to different bytes",
          );
        }
        return transfer;
      }
      this.database
        .prepare(
          `INSERT INTO companion_transfer_chunks (
            transfer_id, whole_file_sha256, chunk_index, chunk_offset,
            chunk_sha256, plaintext_bytes, received_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.transferId,
          chunk.wholeFileSha256,
          chunk.index,
          chunk.offset,
          chunk.sha256,
          chunk.plaintextBytes,
          chunk.receivedAtMs,
        );
      this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'transferring', revision = revision + 1,
           error_code = NULL, updated_at_ms = ? WHERE transfer_id = ? AND state != 'committed'`,
        )
        .run(chunk.receivedAtMs, chunk.transferId);
      return this.requireTransfer(chunk.transferId);
    });
  }

  claimVerification(
    input: CompanionTransferManifest,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    const manifest = companionTransferManifestSchema.parse(input);
    return withTransaction(this.database, () => {
      const current = this.requireTransfer(manifest.transferId);
      if (
        current.wholeFileSha256 !== manifest.wholeFileSha256 ||
        current.missingChunkCount !== 0 ||
        !["awaiting", "transferring", "interrupted"].includes(current.state)
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "verification requires a complete receiving transfer",
        );
      }
      const destinationIdentity = deterministicDestinationIdentity(manifest);
      const result = this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'verifying', destination_identity = ?,
           revision = revision + 1, error_code = NULL, updated_at_ms = ?
           WHERE transfer_id = ? AND whole_file_sha256 = ? AND revision = ?
             AND state IN ('awaiting', 'transferring', 'interrupted')`,
        )
        .run(
          destinationIdentity,
          nowMs,
          manifest.transferId,
          manifest.wholeFileSha256,
          current.revision,
        );
      if (Number(result.changes) !== 1) {
        throw new CompanionTransferFailure(
          "COMPANION_TRANSFER_CONFLICT",
          "verification lost its revision fence",
        );
      }
      return this.requireTransfer(manifest.transferId);
    });
  }

  claimImport(
    transferId: string,
    expectedRevision: number,
    destinationIdentity: string,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    const result = this.database
      .prepare(
        `UPDATE companion_transfers SET state = 'importing', revision = revision + 1,
         error_code = NULL, updated_at_ms = ?
         WHERE transfer_id = ? AND revision = ? AND state = 'verifying'
           AND destination_identity = ?`,
      )
      .run(nowMs, transferId, expectedRevision, destinationIdentity);
    if (Number(result.changes) !== 1) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_CONFLICT",
        "import claim lost its revision or destination fence",
      );
    }
    return this.requireTransfer(transferId);
  }

  markImportStarted(
    transferId: string,
    expectedRevision: number,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    const result = this.database
      .prepare(
        `UPDATE companion_transfers SET import_started_at_ms = ?,
         revision = revision + 1, updated_at_ms = ?
         WHERE transfer_id = ? AND revision = ? AND state = 'importing'
           AND import_started_at_ms IS NULL`,
      )
      .run(nowMs, nowMs, transferId, expectedRevision);
    if (Number(result.changes) !== 1) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_CONFLICT",
        "import invocation lost its revision fence",
      );
    }
    return this.requireTransfer(transferId);
  }

  checkpoint(
    input: CompanionTransferManifest,
    nowMs = Date.now(),
  ): {
    transferId: string;
    wholeFileSha256: string;
    missingChunks: number[];
    updatedAtMs: number;
  } {
    const manifest = companionTransferManifestSchema.parse(input);
    const transfer = this.requireTransfer(manifest.transferId);
    if (transfer.wholeFileSha256 !== manifest.wholeFileSha256) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_CONFLICT",
        "checkpoint manifest identity changed",
      );
    }
    if (
      transfer.state !== "committed" &&
      nowMs > this.checkpointExpiry(manifest.transferId)
    ) {
      throw new CompanionTransferFailure(
        "COMPANION_CHECKPOINT_EXPIRED",
        "transfer checkpoint expired",
      );
    }
    const received = new Set(
      this.database
        .prepare(
          "SELECT chunk_index FROM companion_transfer_chunks WHERE transfer_id = ?",
        )
        .all(manifest.transferId)
        .map((row) => Number(row.chunk_index)),
    );
    return {
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      missingChunks: Array.from(
        { length: manifest.chunkCount },
        (_, index) => index,
      ).filter((index) => !received.has(index)),
      updatedAtMs: nowMs,
    };
  }

  recordCommittedReceipt(
    input: CompanionTransferManifest,
    rawReceipt: CompanionTransferReceipt,
    authority: {
      meetingId: number;
      processingJobId: number;
      recordingId: number;
      sourceSha256: string;
    },
  ): CompanionTransferRecord {
    const manifest = companionTransferManifestSchema.parse(input);
    const receipt = companionTransferReceiptSchema.parse(rawReceipt);
    if (
      receipt.transferId !== manifest.transferId ||
      receipt.wholeFileSha256 !== manifest.wholeFileSha256 ||
      receipt.sizeBytes !== manifest.sizeBytes
    ) {
      throw new CompanionTransferFailure(
        "COMPANION_RECEIPT_MISMATCH",
        "receipt is not bound to this committed transfer",
      );
    }
    return withTransaction(this.database, () => {
      const current = this.requireTransfer(manifest.transferId);
      if (current.receipt) {
        if (JSON.stringify(current.receipt) !== JSON.stringify(receipt)) {
          throw new CompanionTransferFailure(
            "COMPANION_RECEIPT_MISMATCH",
            "committed receipt cannot be replaced",
          );
        }
        return current;
      }
      if (
        current.state !== "importing" ||
        current.destinationIdentity !==
          deterministicDestinationIdentity(manifest) ||
        current.missingChunkCount !== 0 ||
        authority.sourceSha256 !== manifest.wholeFileSha256 ||
        receipt.desktopRecordingId !== authority.recordingId
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_RECEIPT_MISMATCH",
          "receipt requires complete chunks and matching secure import authority",
        );
      }
      const committedImport = this.database
        .prepare(
          `SELECT m.id AS meeting_id, m.media_authority_id, j.id AS processing_job_id,
             a.source_sha256
           FROM meetings m
           JOIN processing_jobs j ON j.meeting_id = m.id
           JOIN media_authorities a ON a.id = m.media_authority_id
           WHERE m.id = ? AND j.id = ? AND a.id = ?`,
        )
        .get(
          authority.meetingId,
          authority.processingJobId,
          authority.recordingId,
        );
      if (
        !committedImport ||
        String(committedImport.source_sha256) !== authority.sourceSha256
      ) {
        throw new CompanionTransferFailure(
          "COMPANION_RECEIPT_MISMATCH",
          "secure import authority is not durably committed",
        );
      }
      this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'committed', recording_id = ?, meeting_id = ?,
           processing_job_id = ?,
           receipt_json = ?, sender_delete_allowed = 1, revision = revision + 1,
           staging_cleanup_state = 'pending', error_code = NULL,
           updated_at_ms = ?, completed_at_ms = ?
           WHERE transfer_id = ? AND whole_file_sha256 = ? AND state = 'importing'`,
        )
        .run(
          authority.recordingId,
          authority.meetingId,
          authority.processingJobId,
          JSON.stringify(receipt),
          receipt.committedAtMs,
          receipt.committedAtMs,
          manifest.transferId,
          manifest.wholeFileSha256,
        );
      const committed = this.requireTransfer(manifest.transferId);
      if (!committed.senderDeleteAllowed) {
        throw new CompanionTransferFailure(
          "COMPANION_RECEIPT_MISMATCH",
          "durable receipt publication did not commit",
        );
      }
      return committed;
    });
  }

  expireStaleCheckpoints(nowMs = Date.now()): number {
    return Number(
      this.database
        .prepare(
          `UPDATE companion_transfers SET state = 'expired', revision = revision + 1,
           error_code = 'COMPANION_CHECKPOINT_EXPIRED', staging_cleanup_state = 'pending',
           updated_at_ms = ?
           WHERE checkpoint_expires_at_ms < ? AND state NOT IN ('committed', 'canceled', 'expired')`,
        )
        .run(nowMs, nowMs).changes,
    );
  }

  pendingStagingCleanup(): Array<{
    transferId: string;
    wholeFileSha256: string;
    peerDeviceId: string;
    state: CompanionTransferRecord["state"];
  }> {
    return this.database
      .prepare(
        `SELECT transfer_id, whole_file_sha256, peer_device_id, state
         FROM companion_transfers WHERE staging_cleanup_state = 'pending'
         ORDER BY updated_at_ms, transfer_id`,
      )
      .all()
      .map((row) => ({
        transferId: String(row.transfer_id),
        wholeFileSha256: String(row.whole_file_sha256),
        peerDeviceId: String(row.peer_device_id),
        state: String(row.state) as CompanionTransferRecord["state"],
      }));
  }

  markStagingCleanupComplete(
    transferId: string,
    nowMs = Date.now(),
  ): CompanionTransferRecord {
    this.database
      .prepare(
        `UPDATE companion_transfers SET staging_cleanup_state = 'complete',
         revision = revision + 1, updated_at_ms = ?
         WHERE transfer_id = ? AND staging_cleanup_state = 'pending'`,
      )
      .run(nowMs, transferId);
    return this.requireTransfer(transferId);
  }

  getTransfer(transferId: string): CompanionTransferRecord | null {
    const row = this.database
      .prepare(
        `SELECT t.*,
          COALESCE((SELECT SUM(c.plaintext_bytes) FROM companion_transfer_chunks c
            WHERE c.transfer_id = t.transfer_id), 0) AS received_bytes,
          t.chunk_count - (SELECT COUNT(*) FROM companion_transfer_chunks c
            WHERE c.transfer_id = t.transfer_id) AS missing_chunk_count
         FROM companion_transfers t WHERE t.transfer_id = ?`,
      )
      .get(transferId);
    return row ? transferFromRow(row) : null;
  }

  listTransfers(
    limit = companionLimits.maximumHistoryItems,
  ): CompanionTransferRecord[] {
    return this.database
      .prepare(
        `SELECT t.*,
          COALESCE((SELECT SUM(c.plaintext_bytes) FROM companion_transfer_chunks c
            WHERE c.transfer_id = t.transfer_id), 0) AS received_bytes,
          t.chunk_count - (SELECT COUNT(*) FROM companion_transfer_chunks c
            WHERE c.transfer_id = t.transfer_id) AS missing_chunk_count
         FROM companion_transfers t ORDER BY t.updated_at_ms DESC, t.transfer_id LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), companionLimits.maximumHistoryItems))
      .map(transferFromRow);
  }

  private requireTransfer(transferId: string): CompanionTransferRecord {
    const transfer = this.getTransfer(transferId);
    if (!transfer) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_NOT_FOUND",
        "transfer is unavailable",
      );
    }
    return transfer;
  }

  private checkpointExpiry(transferId: string): number {
    const row = this.database
      .prepare(
        "SELECT checkpoint_expires_at_ms FROM companion_transfers WHERE transfer_id = ?",
      )
      .get(transferId);
    if (!row) {
      throw new CompanionTransferFailure(
        "COMPANION_TRANSFER_NOT_FOUND",
        "transfer is unavailable",
      );
    }
    return Number(row.checkpoint_expires_at_ms);
  }

  private bumpRevision(nowMs: number): void {
    this.database
      .prepare(
        `UPDATE companion_settings SET revision = revision + 1, updated_at_ms = ?
         WHERE id = 1`,
      )
      .run(nowMs);
  }
}

function expectedChunkLength(
  transfer: CompanionTransferRecord,
  index: number,
): number {
  if (index < transfer.chunkCount - 1) return transfer.chunkBytes;
  return transfer.sizeBytes - transfer.chunkBytes * (transfer.chunkCount - 1);
}

function transferFromRow(
  row: Record<string, unknown>,
): CompanionTransferRecord {
  const receiptJson = row.receipt_json;
  return {
    transferId: String(row.transfer_id),
    wholeFileSha256: String(row.whole_file_sha256),
    peerDeviceId: String(row.peer_device_id),
    displayName: String(row.display_name),
    sizeBytes: Number(row.size_bytes),
    chunkBytes: Number(row.chunk_bytes),
    chunkCount: Number(row.chunk_count),
    state: String(row.state) as CompanionTransferRecord["state"],
    revision: Number(row.revision),
    errorCode: row.error_code === null ? null : String(row.error_code),
    receivedBytes: Number(row.received_bytes),
    missingChunkCount: Number(row.missing_chunk_count),
    receipt:
      typeof receiptJson === "string"
        ? companionTransferReceiptSchema.parse(JSON.parse(receiptJson))
        : null,
    senderDeleteAllowed: Number(row.sender_delete_allowed) === 1,
    destinationIdentity:
      row.destination_identity === null
        ? null
        : String(row.destination_identity),
    importStartedAtMs:
      row.import_started_at_ms === null
        ? null
        : Number(row.import_started_at_ms),
    stagingCleanupState: String(
      row.staging_cleanup_state,
    ) as CompanionTransferRecord["stagingCleanupState"],
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function deterministicDestinationIdentity(
  manifest: CompanionTransferManifest,
): string {
  return createHash("sha256")
    .update(
      `${companionProtocolIdentity()}:${manifest.transferId}:${manifest.wholeFileSha256}`,
      "utf8",
    )
    .digest("hex");
}

function companionProtocolIdentity(): string {
  return "companion-secure-import/v1";
}
