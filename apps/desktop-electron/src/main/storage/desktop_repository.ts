import type { DatabaseSync } from "node:sqlite";

import type {
  ExecutionIntent,
  IdempotentResult,
  MediaAuthorityRecord,
  AudioRecord,
  ProcessingPhase,
  ProcessingJobRecord,
  PublicationRecord,
} from "../domain/models";
import type { ProcessingTask } from "../../shared/contracts";
import {
  assertProfileOwnedPath,
  type AudioProfilePaths,
} from "../profile/profile_paths";
import { withTransaction } from "./audio_database";
import { AudioWorkspaceRepository } from "./repositories/audio_workspace_repository";

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
  private readonly workspaceRepository: AudioWorkspaceRepository;

  constructor(
    private readonly database: DatabaseSync,
    private readonly profile: AudioProfilePaths,
  ) {
    this.workspaceRepository = new AudioWorkspaceRepository(database, profile);
  }

  createAudio(
    command: {
      idempotencyKey: string;
      sourceIdentity: string;
      displayName: string;
      mediaPath: string;
      durationMs: number;
    },
    nowMs: number,
  ): IdempotentResult<AudioRecord> {
    assertProfileOwnedPath(this.profile, command.mediaPath);
    return withTransaction(this.database, () => {
      const existing = this.findAudioByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        assertSame(
          "audio",
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
          "INSERT INTO audio_items (idempotency_key, source_identity, display_name, media_path, duration_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
        value: this.requireAudio(Number(result.lastInsertRowid)),
        inserted: true,
      };
    });
  }

  enqueueProcessingJob(
    command: {
      audioId: number;
      idempotencyKey: string;
      operationId: string;
      resourceIdentity: string;
      phase?: ProcessingPhase;
      protocolIdentity?: string;
      sourceSha256?: string;
      modelSha256?: string;
      runtimeSha256?: string;
    },
    nowMs: number,
  ): IdempotentResult<ProcessingJobRecord> {
    return withTransaction(this.database, () => {
      const existing = this.findJobByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        assertSame(
          "processing job",
          [
            existing.audioId,
            existing.operationId,
            existing.resourceIdentity,
            existing.phase,
            existing.protocolIdentity,
            existing.sourceSha256,
            existing.modelSha256,
            existing.runtimeSha256,
          ],
          [
            command.audioId,
            command.operationId,
            command.resourceIdentity,
            command.phase ?? "asr",
            command.protocolIdentity ?? "legacy-unbound",
            command.sourceSha256 ?? "legacy-unbound",
            command.modelSha256 ?? "legacy-unbound",
            command.runtimeSha256 ?? "legacy-unbound",
          ],
        );
        return { value: existing, inserted: false };
      }
      const result = this.database
        .prepare(
          "INSERT INTO processing_jobs (audio_id, idempotency_key, operation_id, resource_identity, state, attempt, phase, protocol_identity, source_sha256, model_sha256, runtime_sha256, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          command.audioId,
          command.idempotencyKey,
          command.operationId,
          command.resourceIdentity,
          command.phase ?? "asr",
          command.protocolIdentity ?? "legacy-unbound",
          command.sourceSha256 ?? "legacy-unbound",
          command.modelSha256 ?? "legacy-unbound",
          command.runtimeSha256 ?? "legacy-unbound",
          nowMs,
          nowMs,
        );
      return {
        value: this.requireJob(Number(result.lastInsertRowid)),
        inserted: true,
      };
    });
  }

  saveAudioNote(
    command: { audioId: number; idempotencyKey: string; body: string },
    nowMs: number,
  ): IdempotentResult<{ id: number; audioId: number; body: string }> {
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT id, audio_id, body FROM audio_notes WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (row) {
        const existing = {
          id: Number(row.id),
          audioId: Number(row.audio_id),
          body: String(row.body),
        };
        assertSame(
          "audio note",
          [existing.audioId, existing.body],
          [command.audioId, command.body],
        );
        return { value: existing, inserted: false };
      }
      const result = this.database
        .prepare(
          "INSERT INTO audio_notes (audio_id, idempotency_key, body, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          command.audioId,
          command.idempotencyKey,
          command.body,
          nowMs,
          nowMs,
        );
      return {
        value: {
          id: Number(result.lastInsertRowid),
          audioId: command.audioId,
          body: command.body,
        },
        inserted: true,
      };
    });
  }

  recordReceipt(
    command: {
      audioId: number;
      idempotencyKey: string;
      kind: string;
      payload: Record<string, unknown>;
    },
    nowMs: number,
  ): IdempotentResult<{
    id: number;
    audioId: number;
    kind: string;
    payload: Record<string, unknown>;
  }> {
    const payloadJson = JSON.stringify(command.payload);
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT id, audio_id, kind, payload_json FROM durable_receipts WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (row) {
        assertSame(
          "durable receipt",
          [Number(row.audio_id), String(row.kind), String(row.payload_json)],
          [command.audioId, command.kind, payloadJson],
        );
        return {
          value: {
            id: Number(row.id),
            audioId: Number(row.audio_id),
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
          "INSERT INTO durable_receipts (audio_id, idempotency_key, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          command.audioId,
          command.idempotencyKey,
          command.kind,
          payloadJson,
          nowMs,
        );
      return {
        value: {
          id: Number(result.lastInsertRowid),
          audioId: command.audioId,
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
        audioId: job.audioId,
        operationId: job.operationId,
        attempt: job.attempt,
        sourceIdentity,
        deadlineAtMs,
        resourceIdentity: job.resourceIdentity,
        phase: job.phase,
        protocolIdentity: job.protocolIdentity,
        sourceSha256: job.sourceSha256,
        modelSha256: job.modelSha256,
        runtimeSha256: job.runtimeSha256,
      };
    });
  }

  recordProcessingProgress(
    intent: ExecutionIntent,
    fraction: number,
    nowMs: number,
  ): boolean {
    const updated = this.database
      .prepare(
        "UPDATE processing_jobs SET progress_fraction = ?, updated_at_ms = ? WHERE id = ? AND state = 'running' AND audio_id = ? AND operation_id = ? AND resource_identity = ? AND attempt = ? AND source_identity = ? AND deadline_at_ms = ? AND phase = ? AND protocol_identity = ? AND source_sha256 = ? AND model_sha256 = ? AND runtime_sha256 = ? AND cancel_requested_at_ms IS NULL AND progress_fraction <= ?",
      )
      .run(
        fraction,
        nowMs,
        intent.jobId,
        intent.audioId,
        intent.operationId,
        intent.resourceIdentity,
        intent.attempt,
        intent.sourceIdentity,
        intent.deadlineAtMs,
        intent.phase,
        intent.protocolIdentity,
        intent.sourceSha256,
        intent.modelSha256,
        intent.runtimeSha256,
        fraction,
      );
    if (updated.changes !== 1) throw new AttemptFenceError();
    return true;
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
    nowMs: number,
  ): ExecutionIntent {
    const updated = this.database
      .prepare(
        "UPDATE processing_jobs SET operation_id = ?, resource_identity = ?, phase = ?, protocol_identity = ?, model_sha256 = ?, runtime_sha256 = ?, updated_at_ms = ? WHERE id = ? AND state = 'running' AND audio_id = ? AND operation_id = ? AND resource_identity = ? AND attempt = ? AND source_identity = ? AND deadline_at_ms = ? AND phase = ? AND protocol_identity = ? AND source_sha256 = ? AND model_sha256 = ? AND runtime_sha256 = ? AND cancel_requested_at_ms IS NULL",
      )
      .run(
        next.operationId,
        next.resourceIdentity,
        next.phase,
        next.protocolIdentity,
        next.modelSha256,
        next.runtimeSha256,
        nowMs,
        intent.jobId,
        intent.audioId,
        intent.operationId,
        intent.resourceIdentity,
        intent.attempt,
        intent.sourceIdentity,
        intent.deadlineAtMs,
        intent.phase,
        intent.protocolIdentity,
        intent.sourceSha256,
        intent.modelSha256,
        intent.runtimeSha256,
      );
    if (updated.changes !== 1) throw new AttemptFenceError();
    return { ...intent, ...next };
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
        intent.operationId !== "diarization" ||
        intent.phase !== "diarization" ||
        job.state !== "running" ||
        job.audioId !== intent.audioId ||
        job.operationId !== intent.operationId ||
        job.resourceIdentity !== intent.resourceIdentity ||
        job.attempt !== intent.attempt ||
        job.sourceIdentity !== intent.sourceIdentity ||
        job.deadlineAtMs !== intent.deadlineAtMs ||
        job.phase !== intent.phase ||
        job.protocolIdentity !== intent.protocolIdentity ||
        job.sourceSha256 !== intent.sourceSha256 ||
        job.modelSha256 !== intent.modelSha256 ||
        job.runtimeSha256 !== intent.runtimeSha256
      ) {
        throw new AttemptFenceError();
      }
      const inserted = this.database
        .prepare(
          "INSERT INTO result_publications (audio_id, job_id, operation_id, attempt, source_identity, payload_json, created_at_ms, phase, protocol_identity, source_sha256, model_sha256, runtime_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          job.audioId,
          job.id,
          job.operationId,
          job.attempt,
          intent.sourceIdentity,
          payloadJson,
          nowMs,
          intent.phase,
          intent.protocolIdentity,
          intent.sourceSha256,
          intent.modelSha256,
          intent.runtimeSha256,
        );
      const publicationId = Number(inserted.lastInsertRowid);
      this.workspaceRepository.materializePublishedResult({
        audioId: job.audioId,
        publicationId,
        attempt: job.attempt,
        payload,
        createdAtMs: nowMs,
      });
      const completed = this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'completed', progress_fraction = 1, updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NULL AND attempt = ? AND source_identity = ?",
        )
        .run(nowMs, job.id, job.attempt, intent.sourceIdentity);
      if (completed.changes !== 1) throw new AttemptFenceError();
      this.database
        .prepare(
          "UPDATE audio_items SET active_publication_id = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(publicationId, nowMs, job.audioId);
      return {
        id: publicationId,
        audioId: job.audioId,
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
          "UPDATE processing_jobs SET state = 'canceled', error_code = 'CANCELED', updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NOT NULL AND audio_id = ? AND operation_id = ? AND resource_identity = ? AND attempt = ? AND source_identity = ? AND deadline_at_ms = ? AND phase = ? AND protocol_identity = ? AND source_sha256 = ? AND model_sha256 = ? AND runtime_sha256 = ?",
        )
        .run(
          nowMs,
          intent.jobId,
          intent.audioId,
          intent.operationId,
          intent.resourceIdentity,
          intent.attempt,
          intent.sourceIdentity,
          intent.deadlineAtMs,
          intent.phase,
          intent.protocolIdentity,
          intent.sourceSha256,
          intent.modelSha256,
          intent.runtimeSha256,
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
    reset: Pick<
      ExecutionIntent,
      | "operationId"
      | "resourceIdentity"
      | "phase"
      | "protocolIdentity"
      | "modelSha256"
      | "runtimeSha256"
    >,
    nowMs: number,
  ): boolean {
    return (
      this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'queued', operation_id = ?, resource_identity = ?, phase = ?, protocol_identity = ?, model_sha256 = ?, runtime_sha256 = ?, source_identity = NULL, deadline_at_ms = NULL, cancel_requested_at_ms = NULL, error_code = NULL, progress_fraction = 0, updated_at_ms = ? WHERE id = ? AND state IN ('interrupted', 'failed') AND attempt = ?",
        )
        .run(
          reset.operationId,
          reset.resourceIdentity,
          reset.phase,
          reset.protocolIdentity,
          reset.modelSha256,
          reset.runtimeSha256,
          nowMs,
          jobId,
          expectedAttempt,
        ).changes === 1
    );
  }

  interruptProcessingAttempt(
    intent: ExecutionIntent,
    errorCode: string,
    nowMs: number,
  ): boolean {
    return (
      this.database
        .prepare(
          "UPDATE processing_jobs SET state = 'interrupted', error_code = ?, updated_at_ms = ? WHERE id = ? AND state = 'running' AND cancel_requested_at_ms IS NULL AND audio_id = ? AND operation_id = ? AND resource_identity = ? AND attempt = ? AND source_identity = ? AND deadline_at_ms = ? AND phase = ? AND protocol_identity = ? AND source_sha256 = ? AND model_sha256 = ? AND runtime_sha256 = ?",
        )
        .run(
          errorCode,
          nowMs,
          intent.jobId,
          intent.audioId,
          intent.operationId,
          intent.resourceIdentity,
          intent.attempt,
          intent.sourceIdentity,
          intent.deadlineAtMs,
          intent.phase,
          intent.protocolIdentity,
          intent.sourceSha256,
          intent.modelSha256,
          intent.runtimeSha256,
        ).changes === 1
    );
  }

  sourcePathForJob(jobId: number): string | null {
    const row = this.database
      .prepare(
        "SELECT audio_items.media_path FROM processing_jobs JOIN audio_items ON audio_items.id = processing_jobs.audio_id WHERE processing_jobs.id = ?",
      )
      .get(jobId);
    return row ? String(row.media_path) : null;
  }

  mediaAuthorityForAudio(
    audioId: number,
  ): { mediaPath: string; contentSha256: string } | null {
    const row = this.database
      .prepare(
        `SELECT audio_items.media_path, media_authorities.content_sha256
         FROM audio_items
         JOIN media_authorities ON media_authorities.id = audio_items.media_authority_id
         WHERE audio_items.id = ?`,
      )
      .get(audioId);
    return row
      ? {
          mediaPath: String(row.media_path),
          contentSha256: String(row.content_sha256),
        }
      : null;
  }

  findJob(id: number): ProcessingJobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM processing_jobs WHERE id = ?")
      .get(id);
    return row ? mapJob(row) : null;
  }

  listProcessingJobs(): ProcessingJobRecord[] {
    return this.database
      .prepare("SELECT * FROM processing_jobs ORDER BY created_at_ms, id")
      .all()
      .map(mapJob);
  }

  listProcessingTasks(): ProcessingTask[] {
    return this.database
      .prepare(
        "SELECT processing_jobs.*, audio_items.display_name FROM processing_jobs JOIN audio_items ON audio_items.id = processing_jobs.audio_id ORDER BY processing_jobs.updated_at_ms DESC, processing_jobs.id DESC",
      )
      .all()
      .map((row) => {
        const job = mapJob(row);
        return {
          id: job.id,
          audioId: job.audioId,
          displayName: String(row.display_name),
          state: job.state,
          phase: job.phase,
          progressFraction: job.progressFraction,
          attempt: job.attempt,
          errorCode: job.errorCode,
        };
      });
  }

  countAudios(): number {
    return Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM audio_items").get()
        ?.count ?? 0,
    );
  }

  listMediaAuthorities(): MediaAuthorityRecord[] {
    return this.database
      .prepare("SELECT * FROM media_authorities ORDER BY id")
      .all()
      .map(mapMediaAuthority);
  }

  committedImportForSourceSha256(sourceSha256: string): {
    audio: AudioRecord;
    mediaAuthorityId: number;
    contentSha256: string;
    normalizedPath: string;
    normalizedSizeBytes: number;
  } | null {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
      throw new Error("source authority hash is invalid");
    }
    const rows = this.database
      .prepare(
        `SELECT a.id AS media_authority_id, a.content_sha256,
          a.normalized_path, a.size_bytes,
          m.id AS audio_id
         FROM media_authorities a
         JOIN audio_items m ON m.media_authority_id = a.id
         WHERE a.source_sha256 = ?
         ORDER BY a.id, m.id LIMIT 2`,
      )
      .all(sourceSha256);
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error("source authority resolves to multiple imports");
    }
    const row = rows[0]!;
    return {
      audio: this.requireAudio(Number(row.audio_id)),
      mediaAuthorityId: Number(row.media_authority_id),
      contentSha256: String(row.content_sha256),
      normalizedPath: String(row.normalized_path),
      normalizedSizeBytes: Number(row.size_bytes),
    };
  }

  commitValidatedImport(
    command: {
      displayName: string;
      normalizedPath: string;
      normalizedSha256: string;
      sourceSha256: string;
      normalizedSizeBytes: number;
      durationMs: number;
      receipt: Record<string, unknown>;
    },
    nowMs: number,
  ): {
    audio: AudioRecord;
    mediaAuthorityId: number;
    inserted: boolean;
  } {
    assertProfileOwnedPath(this.profile, command.normalizedPath);
    return withTransaction(this.database, () => {
      const existingAsset = this.database
        .prepare("SELECT * FROM media_authorities WHERE content_sha256 = ?")
        .get(command.normalizedSha256);
      if (existingAsset) {
        const audioRow = this.database
          .prepare("SELECT * FROM audio_items WHERE media_authority_id = ?")
          .get(Number(existingAsset.id));
        if (!audioRow) throw new Error("media authority is missing its audio");
        return {
          audio: mapAudio(audioRow),
          mediaAuthorityId: Number(existingAsset.id),
          inserted: false,
        };
      }
      const receiptJson = JSON.stringify(command.receipt);
      if (Buffer.byteLength(receiptJson, "utf8") > 4_096) {
        throw new Error("secure import receipt exceeded the byte limit");
      }
      const media = this.database
        .prepare(
          "INSERT INTO media_authorities (content_sha256, normalized_path, source_sha256, size_bytes, duration_ms, receipt_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          command.normalizedSha256,
          command.normalizedPath,
          command.sourceSha256,
          command.normalizedSizeBytes,
          command.durationMs,
          receiptJson,
          nowMs,
        );
      const mediaId = Number(media.lastInsertRowid);
      const audio = this.database
        .prepare(
          "INSERT INTO audio_items (idempotency_key, source_identity, display_name, media_path, duration_ms, media_authority_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `media:${command.normalizedSha256}`,
          `pcm:${command.normalizedSha256}`,
          command.displayName,
          command.normalizedPath,
          command.durationMs,
          mediaId,
          nowMs,
          nowMs,
        );
      const audioId = Number(audio.lastInsertRowid);
      return {
        audio: this.requireAudio(audioId),
        mediaAuthorityId: mediaId,
        inserted: true,
      };
    });
  }

  private findAudioByIdempotencyKey(key: string): AudioRecord | null {
    const row = this.database
      .prepare("SELECT * FROM audio_items WHERE idempotency_key = ?")
      .get(key);
    return row ? mapAudio(row) : null;
  }

  private requireAudio(id: number): AudioRecord {
    const row = this.database
      .prepare("SELECT * FROM audio_items WHERE id = ?")
      .get(id);
    if (!row) throw new Error("Inserted audio is missing");
    return mapAudio(row);
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
    audioId: job.audioId,
    operationId: job.operationId,
    attempt: job.attempt,
    sourceIdentity: job.sourceIdentity,
    deadlineAtMs: job.deadlineAtMs,
    resourceIdentity: job.resourceIdentity,
    phase: job.phase,
    protocolIdentity: job.protocolIdentity,
    sourceSha256: job.sourceSha256,
    modelSha256: job.modelSha256,
    runtimeSha256: job.runtimeSha256,
  };
}

function mapAudio(row: Record<string, unknown>): AudioRecord {
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
    audioId: Number(row.audio_id),
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
    phase: String(row.phase) as ProcessingJobRecord["phase"],
    protocolIdentity: String(row.protocol_identity),
    sourceSha256: String(row.source_sha256),
    modelSha256: String(row.model_sha256),
    runtimeSha256: String(row.runtime_sha256),
    progressFraction: Number(row.progress_fraction),
  };
}

function mapMediaAuthority(row: Record<string, unknown>): MediaAuthorityRecord {
  return {
    id: Number(row.id),
    contentSha256: String(row.content_sha256),
    normalizedPath: String(row.normalized_path),
    sourceSha256: String(row.source_sha256),
    sizeBytes: Number(row.size_bytes),
    durationMs: Number(row.duration_ms),
    receipt: JSON.parse(String(row.receipt_json)) as Record<string, unknown>,
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
