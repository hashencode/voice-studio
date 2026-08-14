import type {
  CaptionFormalRetryRequest,
  CaptionSnapshot,
} from "../../../shared/contracts";
import type { TranscriptRepository } from "../../storage/repositories/transcript_repository";
import type { ElectronProfilePaths } from "../../profile/profile_paths";
import { validateFormalMediaAuthority } from "./formal_capture_media";

export interface FormalCaptureMedia {
  normalizedPath: string;
  normalizedSha256: string;
  sourceSha256: string;
  normalizedSizeBytes: number;
  durationMs: number;
  receipt: Record<string, unknown>;
}

export interface FormalProcessingIdentity {
  operationId: "asr";
  resourceIdentity: string;
  protocolIdentity: string;
  modelSha256: string;
  runtimeSha256: string;
}

export class FormalTranscriptHandoffService {
  constructor(
    private readonly options: {
      repository: TranscriptRepository;
      profile: ElectronProfilePaths;
      flushDraft(sessionId: string): Promise<unknown>;
      prepareMedia(sessionId: string): Promise<FormalCaptureMedia>;
      scheduleProcessing(jobId: number): void;
      now?: () => number;
    },
  ) {}

  async finalize(command: {
    sessionId: string;
    displayName: string;
    processing: FormalProcessingIdentity;
  }): Promise<CaptionSnapshot> {
    // A caption flush failure degrades only the disposable draft. The durable
    // capture remains authoritative and must still receive one formal attempt.
    await this.options.flushDraft(command.sessionId).catch(() => undefined);
    const existing = this.options.repository.getSnapshot(command.sessionId);
    if (existing && existing.formal.attempt > 0) return existing;
    const nowMs = this.now();
    this.options.repository.beginFormalPreparation({
      sessionId: command.sessionId,
      displayName: command.displayName,
      ...command.processing,
      nowMs,
    });
    let media = this.options.repository.formalHandoffMedia(command.sessionId);
    try {
      media ??= await this.options.prepareMedia(command.sessionId);
      await validateFormalMediaAuthority(this.options.profile, media);
      this.options.repository.saveFormalHandoff({
        sessionId: command.sessionId,
        displayName: command.displayName,
        ...media,
        ...command.processing,
        nowMs,
      });
    } catch {
      return this.options.repository.markFormalPreparationFailed(
        command.sessionId,
        0,
        nowMs,
      );
    }
    try {
      const result = this.options.repository.enqueueInitialFormal(
        command.sessionId,
        nowMs,
      );
      if (result.inserted && result.jobId != null) {
        this.options.scheduleProcessing(result.jobId);
      }
      return result.snapshot;
    } catch {
      return this.options.repository.markFormalEnqueueFailed(
        command.sessionId,
        0,
        nowMs,
      );
    }
  }

  async reconcileStartup(): Promise<CaptionSnapshot[]> {
    const snapshots: CaptionSnapshot[] = [];
    const maximumRecoveries = 4_096;
    while (snapshots.length < maximumRecoveries) {
      const pending = this.options.repository.pendingFormalFinalizations();
      if (pending.length === 0) return snapshots;
      for (const command of pending) {
        snapshots.push(await this.finalize(command));
        if (snapshots.length === maximumRecoveries) break;
      }
    }
    if (this.options.repository.pendingFormalFinalizations().length > 0) {
      throw new Error("formal startup recovery exceeded its safety bound");
    }
    return snapshots;
  }

  async retry(command: CaptionFormalRetryRequest): Promise<CaptionSnapshot> {
    const cached = this.options.repository.formalRetryReceipt(command);
    if (cached) return cached;
    const persistedMedia = this.options.repository.formalHandoffMedia(
      command.sessionId,
    );
    const preparation = this.options.repository.formalPreparation(
      command.sessionId,
    );
    if (!persistedMedia && preparation) {
      if (
        preparation.state !== "failed" ||
        preparation.currentAttempt !== command.expectedAttempt
      ) {
        throw new Error("formal preparation attempt fence rejected");
      }
      try {
        const media = await this.options.prepareMedia(command.sessionId);
        await validateFormalMediaAuthority(this.options.profile, media);
        this.options.repository.saveFormalHandoff({
          sessionId: command.sessionId,
          displayName: preparation.displayName,
          ...media,
          resourceIdentity: preparation.resourceIdentity,
          protocolIdentity: preparation.protocolIdentity,
          modelSha256: preparation.modelSha256,
          runtimeSha256: preparation.runtimeSha256,
          nowMs: this.now(),
        });
      } catch {
        return this.options.repository.markFormalPreparationFailed(
          command.sessionId,
          command.expectedAttempt,
          this.now(),
          command,
        );
      }
    }
    const result = this.options.repository.retryFormal({
      ...command,
      nowMs: this.now(),
    });
    if (result.inserted && result.jobId != null) {
      this.options.scheduleProcessing(result.jobId);
    }
    return result.snapshot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
