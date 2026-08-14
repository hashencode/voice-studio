export type ProcessingJobState =
  | "queued"
  | "running"
  | "canceling"
  | "interrupted"
  | "completed"
  | "failed"
  | "canceled";

export interface MeetingRecord {
  id: number;
  idempotencyKey: string;
  sourceIdentity: string;
  displayName: string;
  mediaPath: string;
  durationMs: number;
  activePublicationId: number | null;
}

export interface ProcessingJobRecord {
  id: number;
  meetingId: number;
  idempotencyKey: string;
  operationId: string;
  resourceIdentity: string;
  state: ProcessingJobState;
  attempt: number;
  sourceIdentity: string | null;
  deadlineAtMs: number | null;
  cancelRequestedAtMs: number | null;
  errorCode: string | null;
}

export interface ExecutionIntent {
  jobId: number;
  meetingId: number;
  operationId: string;
  attempt: number;
  sourceIdentity: string;
  deadlineAtMs: number;
  resourceIdentity: string;
}

export interface PublicationRecord {
  id: number;
  meetingId: number;
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
