import type { CaptionSnapshot } from "../../../shared/contracts";
import type {
  FormalProcessingIdentity,
  FormalTranscriptHandoffService,
} from "./formal_transcript_handoff_service";

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
}): Promise<CaptionSnapshot | null> {
  if (!options.handoff) return null;
  try {
    const snapshot = options.processing
      ? await options.handoff.finalize({
          sessionId: options.sessionId,
          displayName: options.displayName,
          processing: options.processing,
        })
      : await options.handoff.finalize({
          sessionId: options.sessionId,
          displayName: options.displayName,
          processing: null,
        });
    if (snapshot) options.publish(snapshot);
    return snapshot;
  } catch {
    options.reportFailure();
    return null;
  }
}
