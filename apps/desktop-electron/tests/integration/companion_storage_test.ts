import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIO_SCHEMA_VERSION,
  AudioStorageCompatibilityError,
  openAudioDatabase,
} from "../../src/main/storage/audio_database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

describe("U11 companion transfer authority", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  it("creates fresh Audio companion tables and never stores credential bytes", () => {
    database = openAudioDatabase(":memory:");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: AUDIO_SCHEMA_VERSION,
    });
    const repository = new TransferRepository(database);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    expect(
      JSON.stringify(database.prepare("SELECT * FROM companion_peers").all()),
    ).not.toContain("sharedCredential");
  });

  it("rejects a downgraded profile instead of compatibility-reading it", () => {
    const temporary = mkdtempSync(join(tmpdir(), "voice2text-companion-v10-"));
    try {
      const databasePath = join(temporary, "audios.sqlite3");
      database = openAudioDatabase(databasePath);
      database.exec(`
        DROP TABLE companion_command_receipts;
        DROP TABLE companion_transfer_chunks;
        DROP TABLE companion_transfers;
        DROP TABLE companion_peers;
        DROP TABLE companion_settings;
        PRAGMA user_version = 9;
      `);
      database.close();
      database = undefined;
      expect(() => openAudioDatabase(databasePath)).toThrow(
        AudioStorageCompatibilityError,
      );
    } finally {
      database?.close();
      database = undefined;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("resumes verified missing chunks and rejects stale checkpoints", () => {
    database = openAudioDatabase(":memory:");
    const repository = new TransferRepository(database);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-1",
      sourceAssetId: "mobile-recording-1",
      displayName: "audio.wav",
      sizeBytes: 8_000,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 2,
      createdAtMs: 1,
    };
    repository.beginTransfer(manifest, "mobile-1", 1_000);
    repository.recordVerifiedChunk({
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      index: 0,
      offset: 0,
      plaintextBytes: 4_096,
      sha256: "b".repeat(64),
      receivedAtMs: 2_000,
    });
    expect(repository.checkpoint(manifest, 3_000).missingChunks).toEqual([1]);
    expect(() => repository.checkpoint(manifest, 604_803_001)).toThrowError(
      expect.objectContaining({ code: "COMPANION_CHECKPOINT_EXPIRED" }),
    );
  });

  it("protects committed receipts from expiry and gates sender deletion", () => {
    database = openAudioDatabase(":memory:");
    seedAudio(database);
    const repository = new TransferRepository(database);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-1",
      sourceAssetId: "mobile-recording-1",
      displayName: "audio.wav",
      sizeBytes: 8,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 1,
      createdAtMs: 1,
    };
    repository.beginTransfer(manifest, "mobile-1", 1_000);
    expect(repository.getTransfer("transfer-1")?.senderDeleteAllowed).toBe(
      false,
    );
    expect(() =>
      repository.recordCommittedReceipt(
        manifest,
        {
          schema: "companion-audio-transfer/v2",
          receiptId: "receipt-transfer-1",
          transferId: "transfer-1",
          wholeFileSha256: manifest.wholeFileSha256,
          sizeBytes: 8,
          desktopDeviceId: "desktop-1",
          desktopDeviceName: "Studio Mac",
          desktopRecordingId: 99,
          committedAtMs: 2_000,
          signature: "c2lnbmF0dXJl",
        },
        {
          audioId: 1,
          processingJobId: 5,
          recordingId: 99,
          sourceSha256: manifest.wholeFileSha256,
        },
      ),
    ).toThrow();
    repository.recordVerifiedChunk({
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      index: 0,
      offset: 0,
      plaintextBytes: 8,
      sha256: "b".repeat(64),
      receivedAtMs: 1_500,
    });
    const verifying = repository.claimVerification(manifest, 1_600);
    expect(verifying.state).toBe("verifying");
    expect(verifying.destinationIdentity).toMatch(/^[a-f0-9]{64}$/);
    const importing = repository.claimImport(
      manifest.transferId,
      verifying.revision,
      verifying.destinationIdentity!,
      1_700,
    );
    expect(importing.state).toBe("importing");
    repository.recordCommittedReceipt(
      manifest,
      {
        schema: "companion-audio-transfer/v2",
        receiptId: "receipt-transfer-1",
        transferId: "transfer-1",
        wholeFileSha256: manifest.wholeFileSha256,
        sizeBytes: 8,
        desktopDeviceId: "desktop-1",
        desktopDeviceName: "Studio Mac",
        desktopRecordingId: 99,
        committedAtMs: 2_000,
        signature: "c2lnbmF0dXJl",
      },
      {
        audioId: 1,
        processingJobId: 5,
        recordingId: 99,
        sourceSha256: manifest.wholeFileSha256,
      },
    );
    expect(repository.getTransfer("transfer-1")?.senderDeleteAllowed).toBe(
      true,
    );
    expect(repository.getTransfer("transfer-1")?.stagingCleanupState).toBe(
      "pending",
    );
    expect(() =>
      repository.recordVerifiedChunk({
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        index: 0,
        offset: 0,
        plaintextBytes: 8,
        sha256: "b".repeat(64),
        receivedAtMs: 2_500,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COMPANION_CHUNK_CONFLICT" }),
    );
    repository.markStagingCleanupComplete(manifest.transferId, 3_000);
    expect(repository.getTransfer("transfer-1")?.stagingCleanupState).toBe(
      "complete",
    );
    expect(repository.expireStaleCheckpoints(999_999_999)).toBe(0);
    expect(repository.getTransfer("transfer-1")?.state).toBe("committed");
  });

  it("uses revision-fenced verification/import states and durable cleanup tombstones", () => {
    database = openAudioDatabase(":memory:");
    const repository = new TransferRepository(database);
    repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-cas-1",
      sourceAssetId: "asset-cas-1",
      displayName: "audio.wav",
      sizeBytes: 8,
      wholeFileSha256: "e".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 1,
      createdAtMs: 1,
    };
    repository.beginTransfer(manifest, "mobile-1", 1_000);
    repository.recordVerifiedChunk({
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      index: 0,
      offset: 0,
      plaintextBytes: 8,
      sha256: "f".repeat(64),
      receivedAtMs: 1_100,
    });
    const verifying = repository.claimVerification(manifest, 1_200);
    expect(() =>
      repository.claimImport(
        manifest.transferId,
        verifying.revision - 1,
        verifying.destinationIdentity!,
        1_300,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "COMPANION_TRANSFER_CONFLICT" }),
    );
    const importing = repository.claimImport(
      manifest.transferId,
      verifying.revision,
      verifying.destinationIdentity!,
      1_300,
    );
    const started = repository.markImportStarted(
      manifest.transferId,
      importing.revision,
      1_350,
    );
    expect(started.importStartedAtMs).toBe(1_350);
    expect(() =>
      repository.markImportStarted(
        manifest.transferId,
        started.revision,
        1_360,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "COMPANION_TRANSFER_CONFLICT" }),
    );
    repository.cancelTransfer(manifest.transferId, started.revision, 1_400);
    const canceled = repository.getTransfer(manifest.transferId)!;
    expect(canceled.state).toBe("canceled");
    expect(canceled.stagingCleanupState).toBe("pending");
    expect(() =>
      repository.claimImport(
        manifest.transferId,
        canceled.revision,
        verifying.destinationIdentity!,
        1_500,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "COMPANION_TRANSFER_CONFLICT" }),
    );
  });
});

function seedAudio(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO media_authorities (
      id, content_sha256, normalized_path, source_sha256, size_bytes,
      duration_ms, receipt_json, created_at_ms
    ) VALUES (99, '${"d".repeat(64)}', '/private/tmp/media.wav', '${"a".repeat(64)}', 48, 1000, '{}', 1);
    INSERT INTO audio_items (
      id, idempotency_key, source_identity, display_name, media_path,
      duration_ms, media_authority_id, created_at_ms, updated_at_ms
    ) VALUES (1, 'audio-1', 'source-1', 'Audio', '/private/tmp/media.wav', 1000, 99, 1, 1);
    INSERT INTO processing_jobs (
      id, audio_id, idempotency_key, operation_id, resource_identity,
      state, attempt, created_at_ms, updated_at_ms
    ) VALUES (5, 1, 'processing-1', 'asr', 'resource-1', 'queued', 0, 1, 1);
  `);
}
