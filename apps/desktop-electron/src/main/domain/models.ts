export type ProcessingJobState =
  | "queued"
  | "running"
  | "canceling"
  | "interrupted"
  | "completed"
  | "failed"
  | "canceled";

export type ProcessingPhase = "asr" | "diarization";

export interface ProcessingFence {
  phase: ProcessingPhase;
  protocolIdentity: string;
  sourceSha256: string;
  modelSha256: string;
  runtimeSha256: string;
}

export interface AudioRecord {
  id: number;
  idempotencyKey: string;
  sourceIdentity: string;
  displayName: string;
  mediaPath: string;
  durationMs: number;
  activePublicationId: number | null;
}

export interface ProcessingJobRecord extends ProcessingFence {
  id: number;
  audioId: number;
  idempotencyKey: string;
  operationId: string;
  resourceIdentity: string;
  state: ProcessingJobState;
  attempt: number;
  sourceIdentity: string | null;
  deadlineAtMs: number | null;
  cancelRequestedAtMs: number | null;
  errorCode: string | null;
  progressFraction: number;
}

export interface ExecutionIntent extends ProcessingFence {
  jobId: number;
  audioId: number;
  operationId: string;
  attempt: number;
  sourceIdentity: string;
  deadlineAtMs: number;
  resourceIdentity: string;
}

export interface MediaAuthorityRecord {
  id: number;
  contentSha256: string;
  normalizedPath: string;
  sourceSha256: string;
  sizeBytes: number;
  durationMs: number;
  receipt: Record<string, unknown>;
}

export interface PublicationRecord {
  id: number;
  audioId: number;
  jobId: number;
  operationId: string;
  attempt: number;
  sourceIdentity: string;
  payload: Record<string, unknown>;
}

export interface IdempotentResult<T> {
  value: T;
  inserted: boolean;
}
