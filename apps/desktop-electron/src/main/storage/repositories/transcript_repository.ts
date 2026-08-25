import type { DatabaseSync } from "node:sqlite";

import {
  captionSnapshotSchema,
  captionUtteranceSchema,
  type CaptionSnapshot,
} from "../../../shared/contracts";
import { withTransaction } from "../audio_database";
import {
  assertProfileOwnedPath,
  type AudioProfilePaths,
} from "../../profile/profile_paths";

const SHA256 = /^[a-f0-9]{64}$/;
const MAXIMUM_CAPTION_BACKLOG_BYTES = 960_000;

interface CaptionSessionRow {
  id: number;
  session_id: string;
  state: NonNullable<CaptionSnapshot["draft"]>["state"];
  worker_attempt: number;
  model_sha256: string;
  resource_identity: string;
  runtime_sha256: string;
  protocol_identity: string;
  offset_bytes: number;
  last_sequence: number;
  backlog_bytes: number;
  error_code: string | null;
  revision: number;
}

interface CaptionUtteranceRow {
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
  language: string;
}

interface FormalHandoffRow {
  session_id: string;
  display_name: string;
  normalized_path: string;
  normalized_sha256: string;
  source_sha256: string;
  normalized_size_bytes: number;
  duration_ms: number;
  receipt_json: string;
  resource_identity: string;
  protocol_identity: string;
  model_sha256: string;
  runtime_sha256: string;
  current_attempt: number;
  state: string;
  audio_id: number | null;
  processing_job_id: number | null;
  revision: number;
}

export interface FormalPreparation {
  sessionId: string;
  displayName: string;
  resourceIdentity: string;
  protocolIdentity: string;
  modelSha256: string;
  runtimeSha256: string;
  currentAttempt: number;
  state: "not_queued" | "failed";
  revision: number;
}

export interface DraftExecutionIdentity {
  sessionId: string;
  modelSha256: string;
  resourceIdentity: string;
  runtimeSha256: string;
  protocolIdentity: string;
}

export interface PersistedFormalMedia {
  normalizedPath: string;
  normalizedSha256: string;
  sourceSha256: string;
  normalizedSizeBytes: number;
  durationMs: number;
  receipt: Record<string, unknown>;
}

export interface PendingFormalFinalization {
  sessionId: string;
  displayName: string;
  processing: {
    operationId: "asr";
    resourceIdentity: string;
    protocolIdentity: string;
    modelSha256: string;
    runtimeSha256: string;
  };
}

export class TranscriptRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly profile?: AudioProfilePaths,
  ) {}

  createOrResumeDraft(identity: DraftExecutionIdentity & { nowMs: number }): {
    generationId: number;
    attempt: number;
    state: NonNullable<CaptionSnapshot["draft"]>["state"];
    offsetBytes: number;
    firstSequence: number;
  } {
    assertExecutionIdentity(identity);
    const existing = this.findSession(identity.sessionId);
    if (existing) {
      if (
        existing.model_sha256 !== identity.modelSha256 ||
        existing.resource_identity !== identity.resourceIdentity ||
        existing.runtime_sha256 !== identity.runtimeSha256 ||
        existing.protocol_identity !== identity.protocolIdentity
      ) {
        throw new Error("caption draft execution identity conflict");
      }
      return {
        generationId: existing.id,
        attempt: existing.worker_attempt,
        state: existing.state,
        offsetBytes: existing.offset_bytes,
        firstSequence: existing.last_sequence + 1,
      };
    }
    const result = this.database
      .prepare(
        `INSERT INTO caption_sessions (
          session_id, state, worker_attempt, model_sha256,
          resource_identity, runtime_sha256, protocol_identity,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'preparing', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.sessionId,
        identity.modelSha256,
        identity.resourceIdentity,
        identity.runtimeSha256,
        identity.protocolIdentity,
        identity.nowMs,
        identity.nowMs,
      );
    return {
      generationId: Number(result.lastInsertRowid),
      attempt: 1,
      state: "preparing",
      offsetBytes: 0,
      firstSequence: 1,
    };
  }

  beginWorkerAttempt(
    sessionId: string,
    generationId: number,
    nowMs: number,
  ): { generationId: number; attempt: number } {
    const current = this.requireSession(sessionId);
    if (current.id !== generationId) {
      throw new Error("caption generation fence rejected");
    }
    const attempt = checkedIncrement(current.worker_attempt, "caption attempt");
    const revision = checkedIncrement(current.revision, "caption revision");
    const changes = this.database
      .prepare(
        `UPDATE caption_sessions SET worker_attempt = ?, state = 'preparing',
          error_code = NULL, revision = ?, updated_at_ms = ?
        WHERE id = ? AND worker_attempt = ? AND revision = ?`,
      )
      .run(
        attempt,
        revision,
        nowMs,
        generationId,
        current.worker_attempt,
        current.revision,
      ).changes;
    if (changes !== 1)
      throw new Error("caption attempt compare-and-swap failed");
    return { generationId, attempt };
  }

  appendDraftUtterance(command: {
    sessionId: string;
    generationId: number;
    attempt: number;
    sequence: number;
    startMs: number;
    endMs: number;
    text: string;
    language: string;
    workerOffsetBytes: number;
    modelSha256: string;
    nowMs: number;
  }): void {
    const utterance = captionUtteranceSchema.parse({
      sequence: command.sequence,
      startMs: command.startMs,
      endMs: command.endMs,
      text: command.text,
      language: command.language,
    });
    if (
      !Number.isSafeInteger(command.workerOffsetBytes) ||
      command.workerOffsetBytes < 0 ||
      command.workerOffsetBytes % 3_200 !== 0
    ) {
      throw new Error("caption worker offset is not frame aligned");
    }
    if (!SHA256.test(command.modelSha256)) {
      throw new Error("caption model hash is invalid");
    }
    // 16 kHz mono s16le is 32 bytes per millisecond.
    if (utterance.endMs > command.workerOffsetBytes / 32) {
      throw new Error("caption utterance escaped the processed offset");
    }
    withTransaction(this.database, () => {
      const current = this.requireSession(command.sessionId);
      if (current.id !== command.generationId) {
        throw new Error("caption generation fence rejected");
      }
      if (current.worker_attempt !== command.attempt) {
        throw new Error("caption attempt fence rejected");
      }
      if (current.model_sha256 !== command.modelSha256) {
        throw new Error("caption model fence rejected");
      }
      const existing = this.database
        .prepare(
          `SELECT worker_attempt, start_ms, end_ms, text, language,
            worker_offset_bytes, model_sha256
          FROM caption_utterances
          WHERE caption_session_id = ? AND sequence = ?`,
        )
        .get(current.id, utterance.sequence);
      if (existing) {
        if (
          Number(existing.worker_attempt) === command.attempt &&
          Number(existing.start_ms) === utterance.startMs &&
          Number(existing.end_ms) === utterance.endMs &&
          String(existing.text) === utterance.text &&
          String(existing.language) === utterance.language &&
          Number(existing.worker_offset_bytes) === command.workerOffsetBytes &&
          String(existing.model_sha256) === command.modelSha256
        ) {
          return;
        }
        throw new Error("caption sequence replay conflict");
      }
      if (utterance.sequence !== current.last_sequence + 1) {
        throw new Error("caption sequence is not contiguous");
      }
      if (command.workerOffsetBytes < current.offset_bytes) {
        throw new Error("caption worker offset moved backwards");
      }
      this.database
        .prepare(
          `INSERT INTO caption_utterances (
            caption_session_id, sequence, worker_attempt, start_ms, end_ms,
            text, language, worker_offset_bytes, model_sha256, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.id,
          utterance.sequence,
          command.attempt,
          utterance.startMs,
          utterance.endMs,
          utterance.text,
          utterance.language,
          command.workerOffsetBytes,
          command.modelSha256,
          command.nowMs,
        );
      this.database
        .prepare(
          `UPDATE caption_sessions SET state = 'running', last_sequence = ?,
            offset_bytes = ?, revision = ?, updated_at_ms = ?
          WHERE id = ? AND worker_attempt = ? AND revision = ?`,
        )
        .run(
          utterance.sequence,
          command.workerOffsetBytes,
          checkedIncrement(current.revision, "caption revision"),
          command.nowMs,
          current.id,
          command.attempt,
          current.revision,
        );
    });
  }

  advanceDraftSilence(command: {
    sessionId: string;
    generationId: number;
    attempt: number;
    sequence: number;
    startMs: number;
    endMs: number;
    workerOffsetBytes: number;
    modelSha256: string;
    nowMs: number;
  }): void {
    if (
      !Number.isSafeInteger(command.sequence) ||
      command.sequence <= 0 ||
      !Number.isSafeInteger(command.startMs) ||
      command.startMs < 0 ||
      !Number.isSafeInteger(command.endMs) ||
      command.endMs <= command.startMs ||
      !Number.isSafeInteger(command.workerOffsetBytes) ||
      command.workerOffsetBytes < 0 ||
      command.workerOffsetBytes % 3_200 !== 0 ||
      command.endMs > command.workerOffsetBytes / 32 ||
      !SHA256.test(command.modelSha256)
    ) {
      throw new Error("caption silence event is invalid");
    }
    withTransaction(this.database, () => {
      const current = this.requireSession(command.sessionId);
      if (current.id !== command.generationId) {
        throw new Error("caption generation fence rejected");
      }
      if (current.worker_attempt !== command.attempt) {
        throw new Error("caption attempt fence rejected");
      }
      if (current.model_sha256 !== command.modelSha256) {
        throw new Error("caption model fence rejected");
      }
      if (command.sequence !== current.last_sequence + 1) {
        throw new Error("caption sequence is not contiguous");
      }
      if (command.workerOffsetBytes < current.offset_bytes) {
        throw new Error("caption worker offset moved backwards");
      }
      const changes = this.database
        .prepare(
          `UPDATE caption_sessions SET state = 'running', last_sequence = ?,
            offset_bytes = ?, revision = ?, updated_at_ms = ?
          WHERE id = ? AND worker_attempt = ? AND revision = ?`,
        )
        .run(
          command.sequence,
          command.workerOffsetBytes,
          checkedIncrement(current.revision, "caption revision"),
          command.nowMs,
          current.id,
          command.attempt,
          current.revision,
        ).changes;
      if (changes !== 1) {
        throw new Error("caption silence compare-and-swap failed");
      }
    });
  }

  updateProgress(command: {
    sessionId: string;
    generationId: number;
    attempt: number;
    offsetBytes: number;
    backlogBytes: number;
    state: "running" | "paused" | "flushing" | "flushed";
    nowMs: number;
  }): void {
    if (
      !Number.isSafeInteger(command.offsetBytes) ||
      command.offsetBytes < 0 ||
      command.offsetBytes % 3_200 !== 0 ||
      !Number.isSafeInteger(command.backlogBytes) ||
      command.backlogBytes < 0 ||
      command.backlogBytes > MAXIMUM_CAPTION_BACKLOG_BYTES
    ) {
      throw new Error("caption progress bounds rejected");
    }
    const current = this.requireSession(command.sessionId);
    if (
      current.id !== command.generationId ||
      current.worker_attempt !== command.attempt
    ) {
      throw new Error("caption progress fence rejected");
    }
    if (command.offsetBytes < current.offset_bytes) {
      throw new Error("caption worker offset moved backwards");
    }
    const changes = this.database
      .prepare(
        `UPDATE caption_sessions SET state = ?, offset_bytes = ?, backlog_bytes = ?,
          revision = ?, updated_at_ms = ?
        WHERE id = ? AND worker_attempt = ? AND revision = ?`,
      )
      .run(
        command.state,
        command.offsetBytes,
        command.backlogBytes,
        checkedIncrement(current.revision, "caption revision"),
        command.nowMs,
        current.id,
        command.attempt,
        current.revision,
      ).changes;
    if (changes !== 1)
      throw new Error("caption progress compare-and-swap failed");
  }

  markDraftState(command: {
    sessionId: string;
    generationId: number;
    attempt: number;
    state: NonNullable<CaptionSnapshot["draft"]>["state"];
    errorCode: string | null;
    nowMs: number;
  }): void {
    if (command.errorCode && command.errorCode.length > 128) {
      throw new Error("caption error code exceeded the limit");
    }
    const current = this.requireSession(command.sessionId);
    if (
      current.id !== command.generationId ||
      current.worker_attempt !== command.attempt
    ) {
      throw new Error("caption state fence rejected");
    }
    const changes = this.database
      .prepare(
        `UPDATE caption_sessions SET state = ?, error_code = ?, revision = ?,
          updated_at_ms = ? WHERE id = ? AND worker_attempt = ? AND revision = ?`,
      )
      .run(
        command.state,
        command.errorCode,
        checkedIncrement(current.revision, "caption revision"),
        command.nowMs,
        current.id,
        current.worker_attempt,
        current.revision,
      ).changes;
    if (changes !== 1) throw new Error("caption state compare-and-swap failed");
  }

  reconcileStartup(nowMs: number): number {
    return Number(
      this.database
        .prepare(
          `UPDATE caption_sessions SET state = 'degraded',
            error_code = 'CAPTION_INTERRUPTED', revision = revision + 1,
            updated_at_ms = ?
          WHERE state IN ('preparing', 'running', 'paused', 'flushing')`,
        )
        .run(nowMs).changes,
    );
  }

  beginFormalPreparation(command: {
    sessionId: string;
    displayName: string;
    operationId: "asr";
    resourceIdentity: string;
    protocolIdentity: string;
    modelSha256: string;
    runtimeSha256: string;
    nowMs: number;
  }): void {
    if (
      !/^session-[a-zA-Z0-9-]{12,120}$/.test(command.sessionId) ||
      !SHA256.test(command.resourceIdentity) ||
      !SHA256.test(command.modelSha256) ||
      !SHA256.test(command.runtimeSha256) ||
      command.operationId !== "asr" ||
      command.protocolIdentity !== "desktop-sherpa-worker/v1" ||
      command.displayName.trim().length === 0 ||
      command.displayName.length > 256
    ) {
      throw new Error("caption formal preparation is invalid");
    }
    const capture = this.database
      .prepare("SELECT state FROM capture_sessions WHERE session_id = ?")
      .get(command.sessionId);
    if (
      !capture ||
      !["completed", "partial_capture"].includes(String(capture.state))
    ) {
      throw new Error(
        "caption formal preparation lacks finalized capture authority",
      );
    }
    const existing = this.formalPreparation(command.sessionId);
    if (existing) {
      if (
        existing.displayName !== command.displayName ||
        existing.resourceIdentity !== command.resourceIdentity ||
        existing.protocolIdentity !== command.protocolIdentity ||
        existing.modelSha256 !== command.modelSha256 ||
        existing.runtimeSha256 !== command.runtimeSha256
      ) {
        throw new Error("caption formal preparation identity conflict");
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO caption_formal_preparations (
          session_id, display_name, resource_identity, protocol_identity,
          model_sha256, runtime_sha256, revision, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.sessionId,
        command.displayName,
        command.resourceIdentity,
        command.protocolIdentity,
        command.modelSha256,
        command.runtimeSha256,
        this.findSession(command.sessionId)?.revision ?? 1,
        command.nowMs,
        command.nowMs,
      );
  }

  formalPreparation(sessionId: string): FormalPreparation | null {
    const row = this.database
      .prepare("SELECT * FROM caption_formal_preparations WHERE session_id = ?")
      .get(sessionId);
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      displayName: String(row.display_name),
      resourceIdentity: String(row.resource_identity),
      protocolIdentity: String(row.protocol_identity),
      modelSha256: String(row.model_sha256),
      runtimeSha256: String(row.runtime_sha256),
      currentAttempt: Number(row.current_attempt),
      state: String(row.state) as FormalPreparation["state"],
      revision: Number(row.revision),
    };
  }

  pendingFormalFinalizations(): PendingFormalFinalization[] {
    const rows = this.database
      .prepare(
        `SELECT session_id, display_name, resource_identity,
          protocol_identity, model_sha256, runtime_sha256
        FROM caption_formal_preparations
        WHERE state = 'not_queued' AND current_attempt = 0
        UNION
        SELECT session_id, display_name, resource_identity,
          protocol_identity, model_sha256, runtime_sha256
        FROM caption_formal_handoffs
        WHERE state = 'not_queued' AND current_attempt = 0
        ORDER BY session_id
        LIMIT 256`,
      )
      .all();
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      displayName: String(row.display_name),
      processing: {
        operationId: "asr" as const,
        resourceIdentity: String(row.resource_identity),
        protocolIdentity: String(row.protocol_identity),
        modelSha256: String(row.model_sha256),
        runtimeSha256: String(row.runtime_sha256),
      },
    }));
  }

  markFormalPreparationFailed(
    sessionId: string,
    expectedAttempt: number,
    nowMs: number,
    receipt?: { idempotencyKey: string; expectedAttempt: number },
  ): CaptionSnapshot {
    let snapshot: CaptionSnapshot | null = null;
    withTransaction(this.database, () => {
      const preparation = this.formalPreparation(sessionId);
      if (!preparation || preparation.currentAttempt !== expectedAttempt) {
        throw new Error("formal preparation attempt fence rejected");
      }
      const attempt = checkedIncrement(
        expectedAttempt,
        "formal preparation attempt",
      );
      this.database
        .prepare(
          `INSERT INTO caption_formal_attempts (
            session_id, attempt, state, error_code, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'failed', 'FORMAL_MEDIA_PREPARATION_FAILED', ?, ?)`,
        )
        .run(sessionId, attempt, nowMs, nowMs);
      const changes = this.database
        .prepare(
          `UPDATE caption_formal_preparations SET current_attempt = ?,
            state = 'failed', error_code = 'FORMAL_MEDIA_PREPARATION_FAILED',
            updated_at_ms = ? WHERE session_id = ? AND current_attempt = ?`,
        )
        .run(attempt, nowMs, sessionId, expectedAttempt).changes;
      if (changes !== 1)
        throw new Error("formal preparation compare-and-swap failed");
      this.bumpCaptionRevision(sessionId, nowMs);
      snapshot = this.requireCaptionSnapshot(sessionId);
      if (receipt) {
        this.saveFormalRetryReceipt(sessionId, receipt, snapshot, nowMs);
      }
    });
    if (!snapshot)
      throw new Error("formal preparation snapshot is unavailable");
    return snapshot;
  }

  saveFormalHandoff(command: {
    sessionId: string;
    displayName: string;
    normalizedPath: string;
    normalizedSha256: string;
    sourceSha256: string;
    normalizedSizeBytes: number;
    durationMs: number;
    receipt: Record<string, unknown>;
    resourceIdentity: string;
    protocolIdentity: string;
    modelSha256: string;
    runtimeSha256: string;
    nowMs: number;
  }): void {
    if (!this.profile) throw new Error("caption formal profile is unavailable");
    assertProfileOwnedPath(this.profile, command.normalizedPath);
    const receiptJson = JSON.stringify(command.receipt);
    if (
      !/^session-[a-zA-Z0-9-]{12,120}$/.test(command.sessionId) ||
      command.displayName.trim().length === 0 ||
      command.displayName.length > 256 ||
      !SHA256.test(command.normalizedSha256) ||
      !SHA256.test(command.sourceSha256) ||
      !SHA256.test(command.resourceIdentity) ||
      !SHA256.test(command.modelSha256) ||
      !SHA256.test(command.runtimeSha256) ||
      command.protocolIdentity.trim().length === 0 ||
      !Number.isSafeInteger(command.normalizedSizeBytes) ||
      command.normalizedSizeBytes <= 44 ||
      !Number.isSafeInteger(command.durationMs) ||
      command.durationMs <= 0 ||
      Buffer.byteLength(receiptJson) > 4_096
    ) {
      throw new Error("caption formal handoff is invalid");
    }
    const capture = this.database
      .prepare(
        `SELECT state, recording_sha256 FROM capture_sessions
        WHERE session_id = ?`,
      )
      .get(command.sessionId);
    if (
      !capture ||
      !["completed", "partial_capture"].includes(String(capture.state)) ||
      String(capture.recording_sha256) !== command.sourceSha256
    ) {
      throw new Error(
        "caption formal handoff lacks finalized capture authority",
      );
    }
    const existing = this.database
      .prepare("SELECT * FROM caption_formal_handoffs WHERE session_id = ?")
      .get(command.sessionId);
    const values = [
      command.displayName,
      command.normalizedPath,
      command.normalizedSha256,
      command.sourceSha256,
      command.normalizedSizeBytes,
      command.durationMs,
      receiptJson,
      command.resourceIdentity,
      command.protocolIdentity,
      command.modelSha256,
      command.runtimeSha256,
    ];
    if (existing) {
      const persisted = [
        String(existing.display_name),
        String(existing.normalized_path),
        String(existing.normalized_sha256),
        String(existing.source_sha256),
        Number(existing.normalized_size_bytes),
        Number(existing.duration_ms),
        String(existing.receipt_json),
        String(existing.resource_identity),
        String(existing.protocol_identity),
        String(existing.model_sha256),
        String(existing.runtime_sha256),
      ];
      if (persisted.some((value, index) => value !== values[index])) {
        throw new Error("caption formal handoff identity conflict");
      }
      this.database
        .prepare("DELETE FROM caption_formal_preparations WHERE session_id = ?")
        .run(command.sessionId);
      return;
    }
    const preparation = this.formalPreparation(command.sessionId);
    const currentAttempt = preparation?.currentAttempt ?? 0;
    const state = preparation?.state ?? "not_queued";
    const errorCode =
      state === "failed" ? "FORMAL_MEDIA_PREPARATION_FAILED" : null;
    const revision =
      preparation?.revision ??
      this.findSession(command.sessionId)?.revision ??
      1;
    this.database
      .prepare(
        `INSERT INTO caption_formal_handoffs (
          session_id, display_name, normalized_path, normalized_sha256,
          source_sha256, normalized_size_bytes, duration_ms, receipt_json,
          resource_identity, protocol_identity, model_sha256, runtime_sha256,
          current_attempt, state, error_code, revision, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.sessionId,
        ...values,
        currentAttempt,
        state,
        errorCode,
        revision,
        command.nowMs,
        command.nowMs,
      );
    this.database
      .prepare("DELETE FROM caption_formal_preparations WHERE session_id = ?")
      .run(command.sessionId);
    this.bumpCaptionRevision(command.sessionId, command.nowMs);
  }

  formalHandoffMedia(sessionId: string): PersistedFormalMedia | null {
    const row = this.database
      .prepare("SELECT * FROM caption_formal_handoffs WHERE session_id = ?")
      .get(sessionId);
    if (!row) return null;
    return {
      normalizedPath: String(row.normalized_path),
      normalizedSha256: String(row.normalized_sha256),
      sourceSha256: String(row.source_sha256),
      normalizedSizeBytes: Number(row.normalized_size_bytes),
      durationMs: Number(row.duration_ms),
      receipt: JSON.parse(String(row.receipt_json)) as Record<string, unknown>,
    };
  }

  syncFormalForProcessingJob(
    processingJobId: number,
    nowMs: number,
  ): CaptionSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT attempts.session_id, attempts.attempt,
          attempts.state AS persisted_state,
          attempts.generation_id AS persisted_generation_id,
          attempts.error_code AS persisted_error_code,
          jobs.state AS job_state, jobs.error_code AS job_error_code,
          generations.id AS completed_generation_id
        FROM caption_formal_attempts AS attempts
        JOIN processing_jobs AS jobs ON jobs.id = attempts.processing_job_id
        LEFT JOIN result_publications AS publications
          ON publications.job_id = jobs.id AND publications.attempt = jobs.attempt
        LEFT JOIN audio_generations AS generations
          ON generations.publication_id = publications.id
          AND generations.audio_id = attempts.audio_id
        WHERE attempts.processing_job_id = ?`,
      )
      .get(processingJobId);
    if (!row) return null;
    const state = mapFormalState(String(row.job_state));
    const generationId =
      state === "completed" && row.completed_generation_id != null
        ? Number(row.completed_generation_id)
        : null;
    if (state === "completed" && generationId == null) {
      throw new Error("formal generation lacks its processing publication");
    }
    const errorCode =
      row.job_error_code == null ? null : String(row.job_error_code);
    if (
      String(row.persisted_state) === state &&
      (row.persisted_generation_id == null
        ? null
        : Number(row.persisted_generation_id)) === generationId &&
      (row.persisted_error_code == null
        ? null
        : String(row.persisted_error_code)) === errorCode
    ) {
      return null;
    }
    const sessionId = String(row.session_id);
    withTransaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE caption_formal_attempts SET state = ?, generation_id = ?,
            error_code = ?, updated_at_ms = ?
          WHERE processing_job_id = ?`,
        )
        .run(state, generationId, errorCode, nowMs, processingJobId);
      this.database
        .prepare(
          `UPDATE caption_formal_handoffs SET state = ?, error_code = ?,
            updated_at_ms = ?
          WHERE session_id = ? AND current_attempt = ?
            AND processing_job_id = ?`,
        )
        .run(
          state,
          errorCode,
          nowMs,
          sessionId,
          Number(row.attempt),
          processingJobId,
        );
      this.bumpCaptionRevision(sessionId, nowMs);
    });
    return this.requireCaptionSnapshot(sessionId);
  }

  reconcileFormalProcessingAttempts(nowMs: number): number {
    const jobIds = this.database
      .prepare(
        `SELECT attempts.processing_job_id AS job_id
         FROM caption_formal_attempts AS attempts
         JOIN processing_jobs AS jobs ON jobs.id = attempts.processing_job_id
         WHERE attempts.state != jobs.state`,
      )
      .all()
      .map((row) => Number(row.job_id));
    for (const jobId of jobIds) this.syncFormalForProcessingJob(jobId, nowMs);
    return jobIds.length;
  }

  enqueueInitialFormal(
    sessionId: string,
    nowMs: number,
  ): { inserted: boolean; jobId: number | null; snapshot: CaptionSnapshot } {
    const handoff = this.requireFormalHandoff(sessionId);
    if (Number(handoff.current_attempt) > 0) {
      return {
        inserted: false,
        jobId:
          handoff.processing_job_id == null
            ? null
            : Number(handoff.processing_job_id),
        snapshot: this.requireCaptionSnapshot(sessionId),
      };
    }
    return this.enqueueFormalAttempt(sessionId, 0, nowMs);
  }

  retryFormal(command: {
    sessionId: string;
    expectedAttempt: number;
    idempotencyKey: string;
    nowMs: number;
  }): { inserted: boolean; jobId: number | null; snapshot: CaptionSnapshot } {
    const cached = this.formalRetryReceipt(command);
    if (cached) {
      return {
        inserted: false,
        jobId: null,
        snapshot: cached,
      };
    }
    const result = this.enqueueFormalAttempt(
      command.sessionId,
      command.expectedAttempt,
      command.nowMs,
      {
        idempotencyKey: command.idempotencyKey,
        expectedAttempt: command.expectedAttempt,
      },
    );
    return result;
  }

  rebindFormalProcessing(
    sessionId: string,
    expectedAttempt: number,
    identity: {
      resourceIdentity: string;
      protocolIdentity: string;
      modelSha256: string;
      runtimeSha256: string;
    },
    nowMs: number,
  ): void {
    if (
      !SHA256.test(identity.resourceIdentity) ||
      identity.protocolIdentity !== "desktop-sherpa-worker/v1" ||
      !SHA256.test(identity.modelSha256) ||
      !SHA256.test(identity.runtimeSha256)
    ) {
      throw new Error("formal retry processing identity is invalid");
    }
    const preparation = this.database
      .prepare(
        `UPDATE caption_formal_preparations SET
          resource_identity = ?, protocol_identity = ?, model_sha256 = ?,
          runtime_sha256 = ?, updated_at_ms = ?
         WHERE session_id = ? AND current_attempt = ? AND state = 'failed'`,
      )
      .run(
        identity.resourceIdentity,
        identity.protocolIdentity,
        identity.modelSha256,
        identity.runtimeSha256,
        nowMs,
        sessionId,
        expectedAttempt,
      ).changes;
    const handoff = this.database
      .prepare(
        `UPDATE caption_formal_handoffs SET
          resource_identity = ?, protocol_identity = ?, model_sha256 = ?,
          runtime_sha256 = ?, updated_at_ms = ?
         WHERE session_id = ? AND current_attempt = ?
           AND state IN ('failed', 'interrupted')`,
      )
      .run(
        identity.resourceIdentity,
        identity.protocolIdentity,
        identity.modelSha256,
        identity.runtimeSha256,
        nowMs,
        sessionId,
        expectedAttempt,
      ).changes;
    if (Number(preparation) + Number(handoff) === 0) {
      throw new Error("formal retry attempt fence rejected");
    }
  }

  formalRetryReceipt(command: {
    sessionId: string;
    expectedAttempt: number;
    idempotencyKey: string;
  }): CaptionSnapshot | null {
    const cached = this.database
      .prepare(
        `SELECT expected_attempt, result_json FROM caption_command_receipts
        WHERE session_id = ? AND idempotency_key = ?`,
      )
      .get(command.sessionId, command.idempotencyKey);
    if (!cached) return null;
    if (Number(cached.expected_attempt) !== command.expectedAttempt) {
      throw new Error("formal retry idempotency conflict");
    }
    return captionSnapshotSchema.parse(JSON.parse(String(cached.result_json)));
  }

  markFormalEnqueueFailed(
    sessionId: string,
    expectedAttempt: number,
    nowMs: number,
  ): CaptionSnapshot {
    withTransaction(this.database, () => {
      const handoff = this.requireFormalHandoff(sessionId);
      if (Number(handoff.current_attempt) !== expectedAttempt) {
        throw new Error("formal attempt fence rejected");
      }
      const attempt = checkedIncrement(expectedAttempt, "formal attempt");
      this.database
        .prepare(
          `INSERT INTO caption_formal_attempts (
            session_id, attempt, state, error_code, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'failed', 'FORMAL_ENQUEUE_FAILED', ?, ?)`,
        )
        .run(sessionId, attempt, nowMs, nowMs);
      this.database
        .prepare(
          `UPDATE caption_formal_handoffs SET current_attempt = ?,
            state = 'failed', audio_id = NULL, processing_job_id = NULL,
            error_code = 'FORMAL_ENQUEUE_FAILED', updated_at_ms = ?
          WHERE session_id = ? AND current_attempt = ?`,
        )
        .run(attempt, nowMs, sessionId, expectedAttempt);
      this.bumpCaptionRevision(sessionId, nowMs);
    });
    return this.requireCaptionSnapshot(sessionId);
  }

  private enqueueFormalAttempt(
    sessionId: string,
    expectedAttempt: number,
    nowMs: number,
    receipt?: { idempotencyKey: string; expectedAttempt: number },
  ): { inserted: boolean; jobId: number; snapshot: CaptionSnapshot } {
    let jobId = 0;
    let snapshot: CaptionSnapshot | null = null;
    withTransaction(this.database, () => {
      const handoff = this.requireFormalHandoff(sessionId);
      if (Number(handoff.current_attempt) !== expectedAttempt) {
        throw new Error("formal attempt fence rejected");
      }
      const derivedState = this.formalState(handoff);
      if (
        expectedAttempt > 0 &&
        derivedState !== "failed" &&
        derivedState !== "interrupted"
      ) {
        throw new Error("formal attempt is not retryable");
      }
      const attempt = checkedIncrement(expectedAttempt, "formal attempt");
      let audioId = handoff.audio_id == null ? null : Number(handoff.audio_id);
      const existingMedia = this.database
        .prepare("SELECT id FROM media_authorities WHERE content_sha256 = ?")
        .get(String(handoff.normalized_sha256));
      if (audioId == null && existingMedia) {
        const existingAudio = this.database
          .prepare("SELECT id FROM audio_items WHERE media_authority_id = ?")
          .get(Number(existingMedia.id));
        if (!existingAudio)
          throw new Error("caption formal media lacks its audio");
        audioId = Number(existingAudio.id);
      }
      if (audioId == null) {
        const media = this.database
          .prepare(
            `INSERT INTO media_authorities (
              content_sha256, normalized_path, source_sha256, size_bytes,
              duration_ms, receipt_json, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            handoff.normalized_sha256,
            handoff.normalized_path,
            handoff.source_sha256,
            handoff.normalized_size_bytes,
            handoff.duration_ms,
            handoff.receipt_json,
            nowMs,
          );
        const audio = this.database
          .prepare(
            `INSERT INTO audio_items (
              idempotency_key, source_identity, display_name, media_path,
              duration_ms, media_authority_id, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `caption-media:${handoff.normalized_sha256}`,
            `caption-pcm:${handoff.normalized_sha256}`,
            handoff.display_name,
            handoff.normalized_path,
            handoff.duration_ms,
            Number(media.lastInsertRowid),
            nowMs,
            nowMs,
          );
        audioId = Number(audio.lastInsertRowid);
      }
      const job = this.database
        .prepare(
          `INSERT INTO processing_jobs (
            audio_id, idempotency_key, operation_id, resource_identity,
            state, attempt, phase, protocol_identity, source_sha256,
            model_sha256, runtime_sha256, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'asr', ?, 'queued', 0, 'asr', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          audioId,
          `caption-formal:${sessionId}:${attempt}`,
          handoff.resource_identity,
          handoff.protocol_identity,
          handoff.normalized_sha256,
          handoff.model_sha256,
          handoff.runtime_sha256,
          nowMs,
          nowMs,
        );
      jobId = Number(job.lastInsertRowid);
      const jobState = String(
        this.database
          .prepare("SELECT state FROM processing_jobs WHERE id = ?")
          .get(jobId)?.state,
      );
      const state = mapFormalState(jobState);
      this.database
        .prepare(
          `INSERT INTO caption_formal_attempts (
            session_id, attempt, audio_id, processing_job_id, state,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, attempt, audioId, jobId, state, nowMs, nowMs);
      const updated = this.database
        .prepare(
          `UPDATE caption_formal_handoffs SET current_attempt = ?, state = ?,
            audio_id = ?, processing_job_id = ?, error_code = NULL,
            updated_at_ms = ? WHERE session_id = ? AND current_attempt = ?`,
        )
        .run(
          attempt,
          state,
          audioId,
          jobId,
          nowMs,
          sessionId,
          expectedAttempt,
        ).changes;
      if (updated !== 1)
        throw new Error("formal attempt compare-and-swap failed");
      this.bumpCaptionRevision(sessionId, nowMs);
      snapshot = this.requireCaptionSnapshot(sessionId);
      if (receipt) {
        this.saveFormalRetryReceipt(sessionId, receipt, snapshot, nowMs);
      }
    });
    if (!snapshot) throw new Error("formal attempt snapshot is unavailable");
    return {
      inserted: true,
      jobId,
      snapshot,
    };
  }

  getSnapshot(sessionId: string): CaptionSnapshot | null {
    const session = this.findSession(sessionId);
    const utterances = session
      ? this.database
          .prepare(
            `SELECT sequence, start_ms, end_ms, text, language
            FROM caption_utterances WHERE caption_session_id = ?
            ORDER BY sequence DESC LIMIT 128`,
          )
          .all(session.id)
          .map((raw) => raw as unknown as CaptionUtteranceRow)
          .reverse()
          .map((row) => ({
            sequence: row.sequence,
            startMs: row.start_ms,
            endMs: row.end_ms,
            text: row.text,
            language: row.language,
          }))
      : [];
    const formal = this.database
      .prepare(
        `SELECT handoff.current_attempt AS attempt,
          handoff.state AS handoff_state, handoff.error_code AS handoff_error,
          jobs.state AS job_state, jobs.error_code AS job_error,
          handoff.revision AS formal_revision,
          attempts.generation_id
        FROM caption_formal_handoffs AS handoff
        LEFT JOIN processing_jobs AS jobs ON jobs.id = handoff.processing_job_id
        LEFT JOIN caption_formal_attempts AS attempts
          ON attempts.session_id = handoff.session_id
          AND attempts.attempt = handoff.current_attempt
        WHERE handoff.session_id = ?`,
      )
      .get(sessionId);
    const preparation = formal ? null : this.formalPreparation(sessionId);
    if (!session && !formal && !preparation) return null;
    const formalState = formal
      ? mapFormalState(
          formal.job_state == null
            ? String(formal.handoff_state)
            : String(formal.job_state),
        )
      : (preparation?.state ?? "not_queued");
    return captionSnapshotSchema.parse({
      sessionId,
      revision: formal
        ? Number(formal.formal_revision)
        : (preparation?.revision ?? session!.revision),
      draft: session
        ? {
            generationId: session.id,
            attempt: session.worker_attempt,
            state: session.state,
            utterances,
            hasEarlierUtterances: session.last_sequence > utterances.length,
            backlogBytes: session.backlog_bytes,
            errorCode: session.error_code,
          }
        : null,
      formal: formal
        ? {
            generationId:
              formalState === "completed" && formal.generation_id != null
                ? Number(formal.generation_id)
                : null,
            attempt: Number(formal.attempt),
            state: formalState,
            errorCode:
              formal.job_error != null
                ? String(formal.job_error)
                : formal.handoff_error != null
                  ? String(formal.handoff_error)
                  : null,
          }
        : preparation
          ? {
              generationId: null,
              attempt: preparation.currentAttempt,
              state: preparation.state,
              errorCode:
                preparation.state === "failed"
                  ? "FORMAL_MEDIA_PREPARATION_FAILED"
                  : null,
            }
          : {
              generationId: null,
              attempt: 0,
              state: "not_queued",
              errorCode: null,
            },
      displayAuthority:
        formalState === "completed"
          ? "formal"
          : utterances.length > 0
            ? "live_draft"
            : "none",
    });
  }

  private findSession(sessionId: string): CaptionSessionRow | null {
    return (
      (this.database
        .prepare("SELECT * FROM caption_sessions WHERE session_id = ?")
        .get(sessionId) as unknown as CaptionSessionRow | undefined) ?? null
    );
  }

  private requireSession(sessionId: string): CaptionSessionRow {
    const session = this.findSession(sessionId);
    if (!session) throw new Error("caption draft does not exist");
    return session;
  }

  private requireFormalHandoff(sessionId: string): FormalHandoffRow {
    const row = this.database
      .prepare("SELECT * FROM caption_formal_handoffs WHERE session_id = ?")
      .get(sessionId);
    if (!row) throw new Error("caption formal handoff does not exist");
    return row as unknown as FormalHandoffRow;
  }

  private saveFormalRetryReceipt(
    sessionId: string,
    receipt: { idempotencyKey: string; expectedAttempt: number },
    snapshot: CaptionSnapshot,
    nowMs: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO caption_command_receipts (
          session_id, idempotency_key, action, expected_attempt,
          result_json, created_at_ms
        ) VALUES (?, ?, 'retry-formal', ?, ?, ?)`,
      )
      .run(
        sessionId,
        receipt.idempotencyKey,
        receipt.expectedAttempt,
        JSON.stringify(snapshot),
        nowMs,
      );
  }

  private formalState(
    handoff: FormalHandoffRow,
  ): CaptionSnapshot["formal"]["state"] {
    if (handoff.processing_job_id == null) {
      return mapFormalState(String(handoff.state));
    }
    const job = this.database
      .prepare("SELECT state FROM processing_jobs WHERE id = ?")
      .get(Number(handoff.processing_job_id));
    return mapFormalState(job ? String(job.state) : String(handoff.state));
  }

  private requireCaptionSnapshot(sessionId: string): CaptionSnapshot {
    const snapshot = this.getSnapshot(sessionId);
    if (!snapshot) throw new Error("caption snapshot is unavailable");
    return snapshot;
  }

  private bumpCaptionRevision(sessionId: string, nowMs: number): void {
    const draftChanged = this.database
      .prepare(
        "UPDATE caption_sessions SET revision = revision + 1, updated_at_ms = ? WHERE session_id = ?",
      )
      .run(nowMs, sessionId).changes;
    const preparationChanged = this.database
      .prepare(
        "UPDATE caption_formal_preparations SET revision = revision + 1, updated_at_ms = ? WHERE session_id = ?",
      )
      .run(nowMs, sessionId).changes;
    const handoffChanged = this.database
      .prepare(
        "UPDATE caption_formal_handoffs SET revision = revision + 1, updated_at_ms = ? WHERE session_id = ?",
      )
      .run(nowMs, sessionId).changes;
    if (
      Number(draftChanged) +
        Number(preparationChanged) +
        Number(handoffChanged) <
      1
    ) {
      throw new Error("caption aggregate is unavailable");
    }
  }
}

function assertExecutionIdentity(identity: DraftExecutionIdentity): void {
  if (
    !/^session-[a-zA-Z0-9-]{12,120}$/.test(identity.sessionId) ||
    !SHA256.test(identity.modelSha256) ||
    !SHA256.test(identity.resourceIdentity) ||
    !SHA256.test(identity.runtimeSha256) ||
    identity.protocolIdentity !== "sensevoice-live-caption-worker/v1"
  ) {
    throw new Error("caption draft execution identity is invalid");
  }
}

function checkedIncrement(value: number, label: string): number {
  const result = value + 1;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} overflow`);
  return result;
}

function mapFormalState(state: string): CaptionSnapshot["formal"]["state"] {
  if (
    state === "not_queued" ||
    state === "queued" ||
    state === "running" ||
    state === "completed" ||
    state === "failed" ||
    state === "interrupted"
  ) {
    return state;
  }
  if (state === "canceled") return "failed";
  throw new Error("caption formal state is invalid");
}
