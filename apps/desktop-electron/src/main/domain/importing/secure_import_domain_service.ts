import { lstatSync } from "node:fs";

import {
  secureImportReceiptSchema,
  type SecureImportReceipt,
} from "../../../shared/contracts";
import type { DesktopDomainService } from "../desktop_domain_service";
import { sha256File } from "../../security/sha256_file";

interface SecureImportDiscardPort {
  discard(path: string): Promise<void>;
}

export class SecureImportDomainService {
  constructor(
    private readonly domain: DesktopDomainService,
    private readonly discardPort: SecureImportDiscardPort,
  ) {}

  async commitValidatedImport(command: {
    displayName: string;
    receipt: SecureImportReceipt;
  }): Promise<{
    audioId: number;
    recordingId: number;
    mediaSha256: string;
    inserted: boolean;
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
      });
    } catch (error) {
      if (discardPath) await bestEffortDiscard(this.discardPort, discardPath);
      throw error;
    }
    if (!commit.inserted && commit.audio.mediaPath !== receipt.normalizedPath) {
      await this.discardPort.discard(receipt.normalizedPath);
    }
    return {
      audioId: commit.audio.id,
      recordingId: commit.mediaAuthorityId,
      mediaSha256: receipt.normalizedSha256,
      inserted: commit.inserted,
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
  return [...(basename || "未命名音频")].slice(0, 160).join("");
}
