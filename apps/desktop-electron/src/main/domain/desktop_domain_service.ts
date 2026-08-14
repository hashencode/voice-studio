import type {
  ExecutionIntent,
  IdempotentResult,
  MeetingRecord,
  ProcessingJobRecord,
  PublicationRecord,
} from "./models";
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

  createMeeting(command: {
    idempotencyKey: string;
    sourceIdentity: string;
    displayName: string;
    mediaPath: string;
    durationMs: number;
  }): IdempotentResult<MeetingRecord> {
    requireText(command.idempotencyKey, "meeting idempotency key");
    requireText(command.sourceIdentity, "meeting source identity");
    requireText(command.displayName, "meeting display name");
    requireText(command.mediaPath, "meeting media path");
    if (!Number.isSafeInteger(command.durationMs) || command.durationMs < 0) {
      throw new DomainValidationError("Meeting duration is invalid");
    }
    return this.repository.createMeeting(command, this.now());
  }

  enqueueProcessingJob(command: {
    meetingId: number;
    idempotencyKey: string;
    operationId: string;
    resourceIdentity: string;
  }): IdempotentResult<ProcessingJobRecord> {
    requirePositiveInteger(command.meetingId, "meeting id");
    requireText(command.idempotencyKey, "job idempotency key");
    requireText(command.operationId, "operation id");
    requireText(command.resourceIdentity, "resource identity");
    return this.repository.enqueueProcessingJob(command, this.now());
  }

  saveMeetingNote(command: {
    meetingId: number;
    idempotencyKey: string;
    body: string;
  }) {
    requirePositiveInteger(command.meetingId, "meeting id");
    requireText(command.idempotencyKey, "note idempotency key");
    requireText(command.body, "note body");
    return this.repository.saveMeetingNote(command, this.now());
  }

  recordReceipt(command: {
    meetingId: number;
    idempotencyKey: string;
    kind: string;
    payload: Record<string, unknown>;
  }) {
    requirePositiveInteger(command.meetingId, "meeting id");
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

  retryInterruptedJob(jobId: number, expectedAttempt: number): boolean {
    requirePositiveInteger(jobId, "job id");
    requirePositiveInteger(expectedAttempt, "expected attempt");
    return this.repository.retryInterruptedJob(
      jobId,
      expectedAttempt,
      this.now(),
    );
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
