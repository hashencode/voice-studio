import type { DatabaseSync } from "node:sqlite";

import type {
  ExecutionIntent,
  IdempotentResult,
  MeetingRecord,
  ProcessingJobRecord,
  PublicationRecord,
} from "../domain/models";
import {
  assertProfileOwnedPath,
  type ElectronProfilePaths,
} from "../profile/profile_paths";
import { withTransaction } from "./database";

export class IdempotencyConflictError extends Error {
  constructor(entity: string) {
    super(`${entity} idempotency key was reused with different content`);
    this.name = "IdempotencyConflictError";
  }
}

export class AttemptFenceError extends Error {
  constructor() {
    super(
      "Processing result does not match the active operation attempt/source",
    );
    this.name = "AttemptFenceError";
  }
}

export class DesktopRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly profile: ElectronProfilePaths,
  ) {}

  createMeeting(
    command: {
      idempotencyKey: string;
      sourceIdentity: string;
      displayName: string;
      mediaPath: string;
      durationMs: number;
    },
    nowMs: number,
  ): IdempotentResult<MeetingRecord> {
    assertProfileOwnedPath(this.profile, command.mediaPath);
    return withTransaction(this.database, () => {
      const existing = this.findMeetingByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        assertSame(
          "meeting",
          [
            existing.sourceIdentity,
            existing.displayName,
            existing.mediaPath,
            existing.durationMs,
          ],
          [
            command.sourceIdentity,
            command.displayName,
            command.mediaPath,
            command.durationMs,
          ],
        );
        return { value: existing, inserted: false };
      }
      const result = this.database
        .prepare(
          "INSERT INTO meetings (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          command.idempotencyKey,
          command.sourceIdentity,
          command.displayName,
          command.mediaPath,
          command.durationMs,
          nowMs,
          nowMs,
        );
      return {
        value: this.requireMeeting(Number(result.lastInsertRowid)),
        inserted: true,
      };
    });
  }

  enqueueProcessingJob(
    command: {
      meetingId: number;
      idempotencyKey: string;
      operationId: string;
      resourceIdentity: string;
    },
    nowMs: number,
  ): IdempotentResult<ProcessingJobRecord> {
    return withTransaction(this.database, () => {
      const existing = this.findJobByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        assertSame(
          "processing job",
          [existing.meetingId, existing.operationId, existing.resourceIdentity],
          [command.meetingId, command.operationId, command.resourceIdentity],
        );
        return { value: existing, inserted: false };
      }
      const result = this.database
        .prepare(
          "INSERT INTO processing_jobs (meeting_id, idempotency_key, operation_id, resource_identity, state, attempt, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
        )
        .run(
          command.meetingId,
          command.idempotencyKey,
          command.operationId,
          command.resourceIdentity,
          nowMs,
          nowMs,
        );
      return {
        value: this.requireJob(Number(result.lastInsertRowid)),
        inserted: true,
      };
    });
  }

  saveMeetingNote(
    command: { meetingId: number; idempotencyKey: string; body: string },
    nowMs: number,
  ): IdempotentResult<{ id: number; meetingId: number; body: string }> {
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT id, meeting_id, body FROM meeting_notes WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (row) {
        const existing = {
          id: Number(row.id),
          meetingId: Number(row.meeting_id),
          body: String(row.body),
        };
        assertSame(
          "meeting note",
          [existing.meetingId, existing.body],
          [command.meetingId, command.body],
        );
        return { value: existing, inserted: false };
      }
      const result = this.database
        .prepare(
          "INSERT INTO meeting_notes (meeting_id, idempotency_key, body, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          command.meetingId,
          command.idempotencyKey,
          command.body,
          nowMs,
          nowMs,
        );
      return {
        value: {
          id: Number(result.lastInsertRowid),
          meetingId: command.meetingId,
          body: command.body,
        },
        inserted: true,
      };
    });
  }

  recordReceipt(
    command: {
      meetingId: number;
      idempotencyKey: string;
      kind: string;
      payload: Record<string, unknown>;
    },
    nowMs: number,
  ): IdempotentResult<{
    id: number;
    meetingId: number;
    kind: string;
    payload: Record<string, unknown>;
  }> {
    const payloadJson = JSON.stringify(command.payload);
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT id, meeting_id, kind, payload_json FROM durable_receipts WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (row) {
        assertSame(
          "durable receipt",
          [Number(row.meeting_id), String(row.kind), String(row.payload_json)],
          [command.meetingId, command.kind, payloadJson],
        );
        return {
          value: {
            id: Number(row.id),
            meetingId: Number(row.meeting_id),
            kind: String(row.kind),
            payload: JSON.parse(String(row.payload_json)) as Record<
              string,
              unknown
            >,
          },
          inserted: false,
        };
      }
      const result = this.database
        .prepare(
          "INSERT INTO durable_receipts (meeting_id, idempotency_key, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          command.meetingId,
          command.idempotencyKey,
          command.kind,
          payloadJson,
          nowMs,
        );
      return {
        value: {
          id: Number(result.lastInsertRowid),
          meetingId: command.meetingId,
          kind: command.kind,
          payload: command.payload,
        },
        inserted: true,
      };
    });
  }

  claimNextProcessingJob(
    sourceIdentity: string,
    deadlineAtMs: number,
    nowMs: number,
  ): ExecutionIntent | null {
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT id FROM processing_jobs WHERE state = 'queued' ORDER BY created_at_ms, id LIMIT 1",
        )
        .get();
      if (!row) return null;
      const jobId = Number(row.id);
      const update = this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'running', attempt = attempt + 1, source_identity = ?, deadline_at_ms = ?, error_code = NULL, updated_at_ms = ? WHERE id = ? AND state = 'queued'",
        )
        .run(sourceIdentity, deadlineAtMs, nowMs, jobId);
      if (update.changes !== 1) return null;
      const job = this.requireJob(jobId);
      return {
        jobId: job.id,
        meetingId: job.meetingId,
        operationId: job.operationId,
        attempt: job.attempt,
        sourceIdentity,
        deadlineAtMs,
        resourceIdentity: job.resourceIdentity,
      };
    });
  }

  publishProcessingResult(
    intent: ExecutionIntent,
    payload: Record<string, unknown>,
    nowMs: number,
  ): PublicationRecord {
    const payloadJson = JSON.stringify(payload);
    return withTransaction(this.database, () => {
      const job = this.findJob(intent.jobId);
      if (
        !job ||
        job.state !== "running" ||
        job.meetingId !== intent.meetingId ||
        job.operationId !== intent.operationId ||
        job.resourceIdentity !== intent.resourceIdentity ||
        job.attempt !== intent.attempt ||
        job.sourceIdentity !== intent.sourceIdentity ||
        job.deadlineAtMs !== intent.deadlineAtMs
      ) {
        throw new AttemptFenceError();
      }
      const inserted = this.database
        .prepare(
          "INSERT INTO result_publications (meeting_id, job_id, operation_id, attempt, source_identity, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          job.meetingId,
          job.id,
          job.operationId,
          job.attempt,
          intent.sourceIdentity,
          payloadJson,
          nowMs,
        );
      const publicationId = Number(inserted.lastInsertRowid);
      const completed = this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'completed', updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NULL AND attempt = ? AND source_identity = ?",
        )
        .run(nowMs, job.id, job.attempt, intent.sourceIdentity);
      if (completed.changes !== 1) throw new AttemptFenceError();
      this.database
        .prepare(
          "UPDATE meetings SET active_publication_id = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(publicationId, nowMs, job.meetingId);
      return {
        id: publicationId,
        meetingId: job.meetingId,
        jobId: job.id,
        operationId: job.operationId,
        attempt: job.attempt,
        sourceIdentity: intent.sourceIdentity,
        payload,
      };
    });
  }

  requestProcessingCancellation(
    jobId: number,
    nowMs: number,
  ): ExecutionIntent | null {
    return withTransaction(this.database, () => {
      const job = this.findJob(jobId);
      if (!job || (job.state !== "running" && job.state !== "canceling")) {
        return null;
      }
      if (
        job.sourceIdentity == null ||
        job.deadlineAtMs == null ||
        job.attempt <= 0
      ) {
        throw new AttemptFenceError();
      }
      if (job.state === "running") {
        const updated = this.database
          .prepare(
            "UPDATE processing_jobs SET cancel_requested_at_ms = ?, error_code = 'CANCEL_REQUESTED', updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NULL AND attempt = ? AND source_identity = ?",
          )
          .run(nowMs, nowMs, job.id, job.attempt, job.sourceIdentity);
        if (updated.changes !== 1) throw new AttemptFenceError();
      }
      return executionIntentForJob(job);
    });
  }

  completeProcessingCancellation(
    intent: ExecutionIntent,
    nowMs: number,
  ): boolean {
    return (
      this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'canceled', error_code = 'CANCELED', updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NOT NULL AND meeting_id = ? AND operation_id = ? AND resource_identity = ? AND attempt = ? AND source_identity = ? AND deadline_at_ms = ?",
        )
        .run(
          nowMs,
          intent.jobId,
          intent.meetingId,
          intent.operationId,
          intent.resourceIdentity,
          intent.attempt,
          intent.sourceIdentity,
          intent.deadlineAtMs,
        ).changes === 1
    );
  }

  reconcileStartup(nowMs: number): number {
    return withTransaction(this.database, () => {
      const interrupted = Number(
        this.database
          .prepare(
            "UPDATE processing_jobs SET state = 'interrupted', error_code = 'PROCESS_INTERRUPTED', updated_at_ms = ? WHERE state = 'running' AND cancel_requested_at_ms IS NULL",
          )
          .run(nowMs).changes,
      );
      const canceled = Number(
        this.database
          .prepare(
            "UPDATE processing_jobs SET state = 'canceled', error_code = 'CANCELED_DURING_RESTART', updated_at_ms = ? WHERE state = 'running' AND cancel_requested_at_ms IS NOT NULL",
          )
          .run(nowMs).changes,
      );
      return interrupted + canceled;
    });
  }

  retryInterruptedJob(
    jobId: number,
    expectedAttempt: number,
    nowMs: number,
  ): boolean {
    return (
      this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'queued', source_identity = NULL, deadline_at_ms = NULL, cancel_requested_at_ms = NULL, error_code = NULL, updated_at_ms = ? WHERE id = ? AND state = 'interrupted' AND attempt = ?",
        )
        .run(nowMs, jobId, expectedAttempt).changes === 1
    );
  }

  findJob(id: number): ProcessingJobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM processing_jobs WHERE id = ?")
      .get(id);
    return row ? mapJob(row) : null;
  }

  private findMeetingByIdempotencyKey(key: string): MeetingRecord | null {
    const row = this.database
      .prepare("SELECT * FROM meetings WHERE idempotency_key = ?")
      .get(key);
    return row ? mapMeeting(row) : null;
  }

  private requireMeeting(id: number): MeetingRecord {
    const row = this.database
      .prepare("SELECT * FROM meetings WHERE id = ?")
      .get(id);
    if (!row) throw new Error("Inserted meeting is missing");
    return mapMeeting(row);
  }

  private findJobByIdempotencyKey(key: string): ProcessingJobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM processing_jobs WHERE idempotency_key = ?")
      .get(key);
    return row ? mapJob(row) : null;
  }

  private requireJob(id: number): ProcessingJobRecord {
    const job = this.findJob(id);
    if (!job) throw new Error("Inserted processing job is missing");
    return job;
  }
}

function executionIntentForJob(job: ProcessingJobRecord): ExecutionIntent {
  if (job.sourceIdentity == null || job.deadlineAtMs == null) {
    throw new AttemptFenceError();
  }
  return {
    jobId: job.id,
    meetingId: job.meetingId,
    operationId: job.operationId,
    attempt: job.attempt,
    sourceIdentity: job.sourceIdentity,
    deadlineAtMs: job.deadlineAtMs,
    resourceIdentity: job.resourceIdentity,
  };
}

function mapMeeting(row: Record<string, unknown>): MeetingRecord {
  return {
    id: Number(row.id),
    idempotencyKey: String(row.idempotency_key),
    sourceIdentity: String(row.source_identity),
    displayName: String(row.display_name),
    mediaPath: String(row.media_path),
    durationMs: Number(row.duration_ms),
    activePublicationId:
      row.active_publication_id == null
        ? null
        : Number(row.active_publication_id),
  };
}

function mapJob(row: Record<string, unknown>): ProcessingJobRecord {
  const persistedState = String(row.state);
  const cancelRequestedAtMs =
    row.cancel_requested_at_ms == null
      ? null
      : Number(row.cancel_requested_at_ms);
  return {
    id: Number(row.id),
    meetingId: Number(row.meeting_id),
    idempotencyKey: String(row.idempotency_key),
    operationId: String(row.operation_id),
    resourceIdentity: String(row.resource_identity),
    state:
      persistedState === "running" && cancelRequestedAtMs != null
        ? "canceling"
        : (persistedState as ProcessingJobRecord["state"]),
    attempt: Number(row.attempt),
    sourceIdentity:
      row.source_identity == null ? null : String(row.source_identity),
    deadlineAtMs:
      row.deadline_at_ms == null ? null : Number(row.deadline_at_ms),
    cancelRequestedAtMs,
    errorCode: row.error_code == null ? null : String(row.error_code),
  };
}

function assertSame(
  entity: string,
  existing: readonly unknown[],
  incoming: readonly unknown[],
): void {
  if (
    existing.length !== incoming.length ||
    existing.some((value, index) => value !== incoming[index])
  ) {
    throw new IdempotencyConflictError(entity);
  }
}
