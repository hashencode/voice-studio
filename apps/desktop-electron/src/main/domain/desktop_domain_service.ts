import type {
  ExecutionIntent,
  IdempotentResult,
  AudioRecord,
  ProcessingPhase,
  ProcessingJobRecord,
  PublicationRecord,
} from "./models";
import type { ProcessingTask } from "../../shared/contracts";
import {
  AttemptFenceError,
  type DesktopRepository,
} from "../storage/desktop_repository";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export class AttemptIdentityError extends Error {
  constructor(options?: ErrorOptions) {
    super("Worker result was rejected by the attempt/source fence", options);
    this.name = "AttemptIdentityError";
  }
}

export class PartialPublicationError extends Error {
  constructor() {
    super("Partial worker output cannot be published durably");
    this.name = "PartialPublicationError";
  }
}

export class DesktopDomainService {
  constructor(
    private readonly repository: DesktopRepository,
    private readonly now: () => number = Date.now,
  ) {}

  createAudio(command: {
    idempotencyKey: string;
    sourceIdentity: string;
    displayName: string;
    mediaPath: string;
    durationMs: number;
  }): IdempotentResult<AudioRecord> {
    requireText(command.idempotencyKey, "audio idempotency key");
    requireText(command.sourceIdentity, "audio source identity");
    requireText(command.displayName, "audio display name");
    requireText(command.mediaPath, "audio media path");
    if (!Number.isSafeInteger(command.durationMs) || command.durationMs < 0) {
      throw new DomainValidationError("Audio duration is invalid");
    }
    return this.repository.createAudio(command, this.now());
  }

  enqueueProcessingJob(command: {
    audioId: number;
    idempotencyKey: string;
    operationId: string;
    resourceIdentity: string;
    phase?: ProcessingPhase;
    protocolIdentity?: string;
    sourceSha256?: string;
    modelSha256?: string;
    runtimeSha256?: string;
  }): IdempotentResult<ProcessingJobRecord> {
    requirePositiveInteger(command.audioId, "audio id");
    requireText(command.idempotencyKey, "job idempotency key");
    requireText(command.operationId, "operation id");
    requireText(command.resourceIdentity, "resource identity");
    for (const [value, label] of [
      [command.protocolIdentity, "protocol identity"],
      [command.sourceSha256, "source hash"],
      [command.modelSha256, "model hash"],
      [command.runtimeSha256, "runtime hash"],
    ] as const) {
      if (value !== undefined) requireText(value, label);
    }
    return this.repository.enqueueProcessingJob(command, this.now());
  }

  commitValidatedImport(command: {
    displayName: string;
    normalizedPath: string;
    normalizedSha256: string;
    sourceSha256: string;
    normalizedSizeBytes: number;
    durationMs: number;
    receipt: Record<string, unknown>;
    resourceIdentity: string;
    phase: ProcessingPhase;
    protocolIdentity: string;
    modelSha256: string;
    runtimeSha256: string;
  }) {
    requireText(command.displayName, "audio display name");
    requireText(command.normalizedPath, "normalized media path");
    for (const [value, label] of [
      [command.normalizedSha256, "normalized media hash"],
      [command.sourceSha256, "source hash"],
      [command.resourceIdentity, "resource identity"],
      [command.protocolIdentity, "protocol identity"],
      [command.modelSha256, "model hash"],
      [command.runtimeSha256, "runtime hash"],
    ] as const) {
      requireText(value, label);
    }
    return this.repository.commitValidatedImport(command, this.now());
  }

  recordProcessingProgress(
    intent: ExecutionIntent,
    progress: { phase: ProcessingPhase; fraction: number },
  ): boolean {
    if (
      !Number.isFinite(progress.fraction) ||
      progress.fraction < 0 ||
      progress.fraction > 1 ||
      progress.phase !== intent.phase
    ) {
      throw new DomainValidationError("Processing progress is invalid");
    }
    try {
      return this.repository.recordProcessingProgress(
        intent,
        progress.fraction,
        this.now(),
      );
    } catch (error) {
      if (error instanceof AttemptFenceError) {
        throw new AttemptIdentityError({ cause: error });
      }
      throw error;
    }
  }

  advanceProcessingPhase(
    intent: ExecutionIntent,
    next: Pick<
      ExecutionIntent,
      | "operationId"
      | "resourceIdentity"
      | "phase"
      | "protocolIdentity"
      | "modelSha256"
      | "runtimeSha256"
    >,
  ): ExecutionIntent {
    if (
      intent.phase !== "asr" ||
      intent.operationId !== "asr" ||
      next.phase !== "diarization" ||
      next.operationId !== "diarization"
    ) {
      throw new DomainValidationError("Processing phase transition is invalid");
    }
    for (const [value, label] of [
      [next.resourceIdentity, "resource identity"],
      [next.protocolIdentity, "protocol identity"],
      [next.modelSha256, "model hash"],
      [next.runtimeSha256, "runtime hash"],
    ] as const) {
      requireText(value, label);
    }
    try {
      return this.repository.advanceProcessingPhase(intent, next, this.now());
    } catch (error) {
      if (error instanceof AttemptFenceError) {
        throw new AttemptIdentityError({ cause: error });
      }
      throw error;
    }
  }

  saveAudioNote(command: {
    audioId: number;
    idempotencyKey: string;
    body: string;
  }) {
    requirePositiveInteger(command.audioId, "audio id");
    requireText(command.idempotencyKey, "note idempotency key");
    requireText(command.body, "note body");
    return this.repository.saveAudioNote(command, this.now());
  }

  recordReceipt(command: {
    audioId: number;
    idempotencyKey: string;
    kind: string;
    payload: Record<string, unknown>;
  }) {
    requirePositiveInteger(command.audioId, "audio id");
    requireText(command.idempotencyKey, "receipt idempotency key");
    requireText(command.kind, "receipt kind");
    return this.repository.recordReceipt(command, this.now());
  }

  claimNextProcessingJob(command: {
    sourceIdentity: string;
    deadlineAtMs: number;
  }): ExecutionIntent | null {
    requireText(command.sourceIdentity, "worker source identity");
    const nowMs = this.now();
    if (
      !Number.isSafeInteger(command.deadlineAtMs) ||
      command.deadlineAtMs <= nowMs
    ) {
      throw new DomainValidationError(
        "Execution deadline must be in the future",
      );
    }
    return this.repository.claimNextProcessingJob(
      command.sourceIdentity,
      command.deadlineAtMs,
      nowMs,
    );
  }

  publishProcessingResult(
    command: ExecutionIntent & {
      complete: boolean;
      payload: Record<string, unknown>;
    },
  ): PublicationRecord {
    if (!command.complete) throw new PartialPublicationError();
    if (
      command.operationId !== "diarization" ||
      command.phase !== "diarization"
    ) {
      throw new AttemptIdentityError();
    }
    try {
      return this.repository.publishProcessingResult(
        command,
        command.payload,
        this.now(),
      );
    } catch (error) {
      if (error instanceof AttemptFenceError) {
        throw new AttemptIdentityError({ cause: error });
      }
      throw error;
    }
  }

  requestProcessingCancellation(jobId: number): ExecutionIntent | null {
    requirePositiveInteger(jobId, "job id");
    return this.repository.requestProcessingCancellation(jobId, this.now());
  }

  completeProcessingCancellation(intent: ExecutionIntent): boolean {
    return this.repository.completeProcessingCancellation(intent, this.now());
  }

  reconcileStartup(): number {
    return this.repository.reconcileStartup(this.now());
  }

  retryInterruptedJob(
    jobId: number,
    expectedAttempt: number,
    reset: Pick<
      ExecutionIntent,
      | "operationId"
      | "resourceIdentity"
      | "phase"
      | "protocolIdentity"
      | "modelSha256"
      | "runtimeSha256"
    >,
  ): boolean {
    requirePositiveInteger(jobId, "job id");
    requirePositiveInteger(expectedAttempt, "expected attempt");
    if (reset.operationId !== "asr" || reset.phase !== "asr") {
      throw new DomainValidationError("Retry must restart from ASR");
    }
    for (const [value, label] of [
      [reset.resourceIdentity, "resource identity"],
      [reset.protocolIdentity, "protocol identity"],
      [reset.modelSha256, "model hash"],
      [reset.runtimeSha256, "runtime hash"],
    ] as const) {
      requireText(value, label);
    }
    return this.repository.retryInterruptedJob(
      jobId,
      expectedAttempt,
      reset,
      this.now(),
    );
  }

  interruptProcessingAttempt(
    intent: ExecutionIntent,
    errorCode: string,
  ): boolean {
    requireText(errorCode, "processing error code");
    return this.repository.interruptProcessingAttempt(
      intent,
      errorCode,
      this.now(),
    );
  }

  listProcessingTasks(): ProcessingTask[] {
    return this.repository.listProcessingTasks();
  }
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DomainValidationError(`${label} is empty`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainValidationError(`${label} is invalid`);
  }
}
