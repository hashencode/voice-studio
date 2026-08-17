import type { CompanionTransferManifest } from "../../../shared/contracts";
import type { TransferRepository } from "../../storage/repositories/transfer_repository";

export interface CompanionCommittedImportAuthority {
  audioId: number;
  jobId: number;
  recordingId: number;
  sourceSha256: string;
  normalizedPath: string;
  normalizedSha256: string;
  normalizedSizeBytes: number;
}

export class CompanionImportCoordinator {
  constructor(
    private readonly options: {
      repository: TransferRepository;
      lookupCommitted(
        sourceSha256: string,
      ): CompanionCommittedImportAuthority | null;
      validateCommitted(
        authority: CompanionCommittedImportAuthority,
      ): Promise<void>;
      publishedPath(destinationIdentity: string): string;
      publishedExists(publishedPath: string): boolean;
      discardPublished(publishedPath: string): Promise<void>;
      importFresh(
        stagedSourcePath: string,
        manifest: CompanionTransferManifest,
        destinationIdentity: string,
      ): Promise<CompanionCommittedImportAuthority>;
      nowMs?: () => number;
    },
  ) {}

  async commitVerifiedTransfer(
    stagedSourcePath: string,
    manifest: CompanionTransferManifest,
  ): Promise<CompanionCommittedImportAuthority> {
    const committed = this.options.lookupCommitted(manifest.wholeFileSha256);
    if (committed) {
      assertCommittedAuthority(committed, manifest);
      await this.options.validateCommitted(committed);
      return committed;
    }
    let transfer = this.options.repository.getTransfer(manifest.transferId);
    if (
      !transfer ||
      transfer.state !== "importing" ||
      !transfer.destinationIdentity ||
      transfer.wholeFileSha256 !== manifest.wholeFileSha256 ||
      transfer.sizeBytes !== manifest.sizeBytes
    ) {
      throw new Error("COMPANION_IMPORT_INTENT_UNAVAILABLE");
    }
    const publishedPath = this.options.publishedPath(
      transfer.destinationIdentity,
    );
    const publishedExists = this.options.publishedExists(publishedPath);
    if (publishedExists && transfer.importStartedAtMs === null) {
      throw new Error("COMPANION_IMPORT_DESTINATION_PREEXISTS");
    }
    if (transfer.importStartedAtMs === null) {
      transfer = this.options.repository.markImportStarted(
        transfer.transferId,
        transfer.revision,
        this.options.nowMs?.() ?? Date.now(),
      );
    } else if (publishedExists) {
      await this.options.discardPublished(publishedPath);
    }
    const imported = await this.options.importFresh(
      stagedSourcePath,
      manifest,
      transfer.destinationIdentity!,
    );
    assertCommittedAuthority(imported, manifest);
    return imported;
  }
}

function assertCommittedAuthority(
  authority: CompanionCommittedImportAuthority,
  manifest: CompanionTransferManifest,
): void {
  if (
    !Number.isSafeInteger(authority.audioId) ||
    authority.audioId < 1 ||
    !Number.isSafeInteger(authority.jobId) ||
    authority.jobId < 1 ||
    !Number.isSafeInteger(authority.recordingId) ||
    authority.recordingId < 1 ||
    authority.sourceSha256 !== manifest.wholeFileSha256 ||
    typeof authority.normalizedPath !== "string" ||
    authority.normalizedPath.length < 1 ||
    !/^[a-f0-9]{64}$/.test(authority.normalizedSha256) ||
    !Number.isSafeInteger(authority.normalizedSizeBytes) ||
    authority.normalizedSizeBytes < 1
  ) {
    throw new Error("COMPANION_IMPORT_AUTHORITY_MISMATCH");
  }
}
