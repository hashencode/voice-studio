import type { CaptionSnapshot } from "../../../shared/contracts";
import type {
  FormalProcessingIdentity,
  FormalTranscriptHandoffService,
} from "./formal_transcript_handoff_service";
import type { CaptureLibraryProjectionReceipt } from "../capture/capture_library_projection_service";

/**
 * Capture commit is the primary durability boundary. Formal processing is a
 * separately retryable projection and must never turn a committed stop/keep
 * into an apparent capture failure.
 */
export async function finalizeCommittedCaptureTranscript(options: {
  handoff: FormalTranscriptHandoffService | null;
  sessionId: string;
  displayName: string;
  processing: FormalProcessingIdentity | null;
  publish(snapshot: CaptionSnapshot): void;
  reportFailure(): void;
}): Promise<CaptionSnapshot | CaptureLibraryProjectionReceipt | null> {
  if (!options.handoff) return null;
  try {
    if (options.processing) {
      const snapshot = await options.handoff.finalize({
        sessionId: options.sessionId,
        displayName: options.displayName,
        processing: options.processing,
      });
      options.publish(snapshot);
      return snapshot;
    }
    return await options.handoff.finalize({
      sessionId: options.sessionId,
      displayName: options.displayName,
      processing: null,
    });
  } catch {
    options.reportFailure();
    return null;
  }
}
