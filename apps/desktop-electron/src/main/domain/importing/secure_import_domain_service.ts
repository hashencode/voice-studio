import { lstatSync } from "node:fs";

import {
  secureImportReceiptSchema,
  type SecureImportReceipt,
} from "../../../shared/contracts";
import type { DesktopDomainService } from "../desktop_domain_service";
import type { ProcessingJobState, ProcessingPhase } from "../models";
import { sha256File } from "../../security/sha256_file";

interface SecureImportDiscardPort {
  discard(path: string): Promise<void>;
}

interface ProcessingResourceIdentity {
  operationId: ProcessingPhase;
  protocolIdentity: string;
  modelSha256: string;
  runtimeSha256: string;
  resourceIdentity: string;
}

export class SecureImportDomainService {
  constructor(
    private readonly domain: DesktopDomainService,
    private readonly discardPort: SecureImportDiscardPort,
  ) {}

  async commitValidatedImport(command: {
    displayName: string;
    receipt: SecureImportReceipt;
    processing: ProcessingResourceIdentity;
  }): Promise<{
    meetingId: number;
    jobId: number;
    mediaSha256: string;
    inserted: boolean;
    state: ProcessingJobState;
    attempt: number;
    progressFraction: number;
  }> {
    const discardPath = candidateDiscardPath(command.receipt);
    let receipt: SecureImportReceipt;
    let commit;
    try {
      receipt = secureImportReceiptSchema.parse(command.receipt);
      const stat = lstatSync(receipt.normalizedPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("normalized media is not a private regular file");
      }
      if (stat.size !== receipt.normalizedSizeBytes) {
        throw new Error("normalized media size does not match its receipt");
      }
      if (
        (await sha256File(receipt.normalizedPath)) !== receipt.normalizedSha256
      ) {
        throw new Error("normalized media hash does not match its receipt");
      }
      commit = this.domain.commitValidatedImport({
        displayName: boundDisplayName(command.displayName),
        normalizedPath: receipt.normalizedPath,
        normalizedSha256: receipt.normalizedSha256,
        sourceSha256: receipt.sourceSha256,
        normalizedSizeBytes: receipt.normalizedSizeBytes,
        durationMs: receipt.durationMs,
        receipt,
        resourceIdentity: command.processing.resourceIdentity,
        phase: command.processing.operationId,
        protocolIdentity: command.processing.protocolIdentity,
        modelSha256: command.processing.modelSha256,
        runtimeSha256: command.processing.runtimeSha256,
      });
    } catch (error) {
      if (discardPath) await bestEffortDiscard(this.discardPort, discardPath);
      throw error;
    }
    if (
      !commit.inserted &&
      commit.meeting.mediaPath !== receipt.normalizedPath
    ) {
      await this.discardPort.discard(receipt.normalizedPath);
    }
    return {
      meetingId: commit.meeting.id,
      jobId: commit.job.id,
      mediaSha256: receipt.normalizedSha256,
      inserted: commit.inserted,
      state: commit.job.state,
      attempt: commit.job.attempt,
      progressFraction: commit.job.progressFraction,
    };
  }
}

function candidateDiscardPath(receipt: SecureImportReceipt): string | null {
  try {
    const value = (receipt as { normalizedPath?: unknown }).normalizedPath;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function bestEffortDiscard(
  port: SecureImportDiscardPort,
  path: string,
): Promise<void> {
  try {
    await port.discard(path);
  } catch {
    // The validation/commit failure remains authoritative.
  }
}

function boundDisplayName(raw: string): string {
  const basename = raw
    .split(/[\\/]/)
    .at(-1)!
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return [...(basename || "未命名会议")].slice(0, 160).join("");
}
