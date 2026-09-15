import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { AudioProfilePaths } from "../../profile/profile_paths";
import type { DesktopDomainService } from "../desktop_domain_service";
import type {
  CaptureLibraryProjectionCursor,
  CaptureRepository,
} from "../../storage/repositories/capture_repository";
import {
  validateFormalMediaAuthority,
  type FormalCaptureMedia,
} from "../captions/formal_capture_media";

export interface CaptureLibraryProjectionReceipt {
  sessionId: string;
  audioId: number;
  inserted: boolean;
}

export type CaptureLibraryProjectionFailure =
  "invalid_authority" | "commit_failed";

export class CaptureLibraryProjectionError extends Error {
  constructor(readonly code: CaptureLibraryProjectionFailure) {
    super(
      code === "invalid_authority"
        ? "Capture media authority could not be verified"
        : "Capture media could not be added to the library",
    );
    this.name = "CaptureLibraryProjectionError";
  }
}

export class CaptureLibraryProjectionService {
  private readonly inFlightBySession = new Map<
    string,
    Promise<{
      receipt: CaptureLibraryProjectionReceipt;
      media: FormalCaptureMedia;
    }>
  >();

  constructor(
    private readonly options: {
      profile: AudioProfilePaths;
      domain: DesktopDomainService;
      prepareMedia(sessionId: string): Promise<FormalCaptureMedia>;
    },
  ) {}

  async project(command: {
    sessionId: string;
    displayName: string;
  }): Promise<CaptureLibraryProjectionReceipt> {
    return (await this.projectWithMedia(command)).receipt;
  }

  projectWithMedia(command: {
    sessionId: string;
    displayName: string;
  }): Promise<{
    receipt: CaptureLibraryProjectionReceipt;
    media: FormalCaptureMedia;
  }> {
    const existing = this.inFlightBySession.get(command.sessionId);
    if (existing) return existing;
    const pending = this.projectWithMediaUnserialized(command).finally(() => {
      if (this.inFlightBySession.get(command.sessionId) === pending) {
        this.inFlightBySession.delete(command.sessionId);
      }
    });
    this.inFlightBySession.set(command.sessionId, pending);
    return pending;
  }

  async reconcileStartup(options: {
    repository: CaptureRepository;
    onProjected?: (receipt: CaptureLibraryProjectionReceipt) => void;
    maxCandidatesPerSlice?: number;
    maxSliceMs?: number;
    now?: () => number;
    yieldControl?: () => Promise<void>;
  }): Promise<{ attempted: number; projected: number; failed: number }> {
    const maxCandidatesPerSlice = options.maxCandidatesPerSlice ?? 16;
    const maxSliceMs = options.maxSliceMs ?? 25;
    if (
      !Number.isSafeInteger(maxCandidatesPerSlice) ||
      maxCandidatesPerSlice <= 0 ||
      maxCandidatesPerSlice > 100 ||
      !Number.isFinite(maxSliceMs) ||
      maxSliceMs <= 0
    ) {
      throw new Error("capture library reconciliation budget is invalid");
    }
    const now = options.now ?? performance.now.bind(performance);
    const yieldControl =
      options.yieldControl ?? (async () => await yieldToEventLoop());
    let cursor: CaptureLibraryProjectionCursor | null = null;
    const result = { attempted: 0, projected: 0, failed: 0 };

    while (true) {
      const sliceStartedAt = now();
      const candidates = options.repository.listLibraryProjectionCandidates(
        cursor,
        maxCandidatesPerSlice,
      );
      if (candidates.length === 0) return result;

      let processed = 0;
      for (const candidate of candidates) {
        let receipt: CaptureLibraryProjectionReceipt | null = null;
        try {
          receipt = await this.project(candidate);
        } catch {
          result.failed += 1;
        }
        if (receipt) {
          result.projected += 1;
          options.onProjected?.(receipt);
        }
        result.attempted += 1;
        processed += 1;
        cursor = candidate.cursor;
        if (now() - sliceStartedAt >= maxSliceMs) break;
      }

      if (
        processed === candidates.length &&
        candidates.length < maxCandidatesPerSlice
      ) {
        return result;
      }
      await yieldControl();
    }
  }

  private async projectWithMediaUnserialized(command: {
    sessionId: string;
    displayName: string;
  }): Promise<{
    receipt: CaptureLibraryProjectionReceipt;
    media: FormalCaptureMedia;
  }> {
    let media: FormalCaptureMedia;
    try {
      media = await this.options.prepareMedia(command.sessionId);
      await validateFormalMediaAuthority(this.options.profile, media);
    } catch {
      throw new CaptureLibraryProjectionError("invalid_authority");
    }
    try {
      const committed = this.options.domain.commitValidatedImport({
        captureSessionId: command.sessionId,
        displayName: command.displayName,
        ...media,
      });
      return {
        media,
        receipt: {
          sessionId: command.sessionId,
          audioId: committed.audio.id,
          inserted: committed.inserted,
        },
      };
    } catch {
      throw new CaptureLibraryProjectionError("commit_failed");
    }
  }
}
