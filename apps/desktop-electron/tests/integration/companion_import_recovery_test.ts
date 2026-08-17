import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionImportCoordinator } from "../../src/main/domain/companion/companion_import_coordinator";
import { openElectronDatabase } from "../../src/main/storage/database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

describe("U11 companion secure-import crash recovery", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  it("rejects a preexisting unbound destination without importing or publishing a receipt", async () => {
    const fixture = importingFixture();
    database = fixture.database;
    const importFresh = vi.fn();
    const discardPublished = vi.fn();
    const coordinator = new CompanionImportCoordinator({
      repository: fixture.repository,
      lookupCommitted: vi.fn().mockReturnValue(null),
      validateCommitted: vi.fn(),
      publishedPath: () => "/private/profile/media/complete/destination.wav",
      publishedExists: () => true,
      discardPublished,
      importFresh,
      nowMs: () => 2_000,
    });

    await expect(
      coordinator.commitVerifiedTransfer(
        "/private/profile/transfers/transfer/complete.media",
        fixture.manifest,
      ),
    ).rejects.toThrow("COMPANION_IMPORT_DESTINATION_PREEXISTS");
    expect(importFresh).not.toHaveBeenCalled();
    expect(discardPublished).not.toHaveBeenCalled();
    expect(
      fixture.repository.getTransfer(fixture.manifest.transferId)
        ?.importStartedAtMs,
    ).toBeNull();
  });

  it("recovers helper-publish-before-DB and DB-before-transfer-receipt exactly once", async () => {
    const fixture = importingFixture();
    database = fixture.database;
    let published = false;
    let committedAuthority: {
      meetingId: number;
      jobId: number;
      recordingId: number;
      sourceSha256: string;
      normalizedPath: string;
      normalizedSha256: string;
      normalizedSizeBytes: number;
    } | null = null;
    const discardPublished = vi.fn(async () => {
      published = false;
    });
    const importFresh = vi
      .fn()
      .mockImplementationOnce(async () => {
        published = true;
        throw new Error("simulated crash after helper publish");
      })
      .mockImplementationOnce(async () => {
        published = true;
        committedAuthority = {
          meetingId: 41,
          jobId: 42,
          recordingId: 43,
          sourceSha256: fixture.manifest.wholeFileSha256,
          normalizedPath: "/private/profile/media/complete/destination.wav",
          normalizedSha256: "d".repeat(64),
          normalizedSizeBytes: 48,
        };
        return committedAuthority;
      });
    const coordinator = new CompanionImportCoordinator({
      repository: fixture.repository,
      lookupCommitted: () => committedAuthority,
      validateCommitted: vi.fn().mockResolvedValue(undefined),
      publishedPath: () => "/private/profile/media/complete/destination.wav",
      publishedExists: () => published,
      discardPublished,
      importFresh,
      nowMs: () => 2_000,
    });

    await expect(
      coordinator.commitVerifiedTransfer(
        "/private/staged.wav",
        fixture.manifest,
      ),
    ).rejects.toThrow("simulated crash after helper publish");
    expect(
      fixture.repository.getTransfer(fixture.manifest.transferId)
        ?.importStartedAtMs,
    ).toBe(2_000);

    const committed = await coordinator.commitVerifiedTransfer(
      "/private/staged.wav",
      fixture.manifest,
    );
    expect(discardPublished).toHaveBeenCalledOnce();
    expect(importFresh).toHaveBeenCalledTimes(2);
    expect(committed).toEqual(committedAuthority);

    const recoveredAfterDatabaseCommit =
      await coordinator.commitVerifiedTransfer(
        "/private/staged.wav",
        fixture.manifest,
      );
    expect(recoveredAfterDatabaseCommit).toEqual(committedAuthority);
    expect(importFresh).toHaveBeenCalledTimes(2);
    expect(discardPublished).toHaveBeenCalledOnce();
  });
});

function importingFixture() {
  const database = openElectronDatabase(":memory:");
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
    transferId: "transfer-import-crash",
    sourceAssetId: "source-import-crash",
    displayName: "meeting.wav",
    sizeBytes: 8,
    wholeFileSha256: "a".repeat(64),
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
    plaintextBytes: manifest.sizeBytes,
    sha256: "b".repeat(64),
    receivedAtMs: 1_100,
  });
  const verifying = repository.claimVerification(manifest, 1_200);
  repository.claimImport(
    manifest.transferId,
    verifying.revision,
    verifying.destinationIdentity!,
    1_300,
  );
  return { database, repository, manifest };
}
