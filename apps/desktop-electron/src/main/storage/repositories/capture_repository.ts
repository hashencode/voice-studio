import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  captureSnapshotSchema,
  captureTitleSchema,
  type CaptureSnapshot,
} from "../../../shared/contracts";
import { withTransaction } from "../audio_database";
import { CAPTURE_LIBRARY_RECEIPT_PREFIX } from "../capture_library_projection_receipt";
import type { CaptureAuthority } from "../../domain/capture/capture_authority";

interface CaptureSessionRow {
  session_id: string;
  title: string;
  state: string;
  capture_mode: string;
  capture_timeline_ms: number;
  system_audio_healthy: number;
  microphone_healthy: number;
  partial_capture: number;
  finalized_chunk_count: number;
  event_count: number;
  gap_count: number;
  interruption_reason: string | null;
  recording_sha256: string | null;
  journal_sha256: string | null;
  workspace_path: string;
  recovery_disposition: string | null;
}

export interface StoredCaptureSession {
  snapshot: CaptureSnapshot;
  title: string;
}

export interface StoredCaptureRecovery extends StoredCaptureSession {
  workspacePath: string;
}

export interface CaptureRecoveryMarkerDiagnostics {
  repaired: number;
  unchanged: number;
}

export interface CaptureLibraryProjectionCursor {
  updatedAtMs: number;
  sessionId: string;
}

export interface CaptureLibraryProjectionCandidate {
  sessionId: string;
  displayName: string;
  cursor: CaptureLibraryProjectionCursor;
}

export class CaptureRepository {
  private readonly recoveryMarkerDiagnostics = {
    repaired: 0,
    unchanged: 0,
  };

  constructor(private readonly database: DatabaseSync) {}

  recoveryMarkerRepairDiagnostics(): CaptureRecoveryMarkerDiagnostics {
    return { ...this.recoveryMarkerDiagnostics };
  }

  beginSession(command: {
    sessionId: string;
    title: string;
    workspacePath: string;
    nowMs: number;
  }): void {
    const workspacePath = path.resolve(command.workspacePath);
    const changes = this.database
      .prepare(
        `INSERT INTO capture_sessions (
          session_id, title, workspace_path, state, capture_mode,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'preparing', 'dual_track', ?, ?)
        ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(
        command.sessionId,
        command.title,
        workspacePath,
        command.nowMs,
        command.nowMs,
      ).changes;
    if (changes === 1) return;
    const existing = this.database
      .prepare(
        "SELECT title, workspace_path FROM capture_sessions WHERE session_id = ?",
      )
      .get(command.sessionId);
    if (
      !existing ||
      existing.title !== command.title ||
      existing.workspace_path !== workspacePath
    ) {
      throw new Error("capture session identity conflict");
    }
  }

  countSessionsCreatedBetween(startMs: number, endMs: number): number {
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    ) {
      throw new Error("capture session count range is invalid");
    }
    return Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM capture_sessions
           WHERE created_at_ms >= ? AND created_at_ms < ?`,
        )
        .get(startMs, endMs)?.count ?? 0,
    );
  }

  hasActionReceipt(sessionId: string, action: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM capture_command_receipts WHERE session_id = ? AND action = ? LIMIT 1",
        )
        .get(sessionId, action),
    );
  }

  nextActionSequence(sessionId: string, action: string): number {
    return (
      Number(
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM capture_command_receipts WHERE session_id = ? AND action = ?",
          )
          .get(sessionId, action)?.count ?? 0,
      ) + 1
    );
  }

  receipt(
    sessionId: string,
    idempotencyKey: string,
  ): { action: string; result: CaptureSnapshot } | null {
    const row = this.database
      .prepare(
        "SELECT action, result_json FROM capture_command_receipts WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey);
    if (!row) return null;
    return {
      action: String(row.action),
      result: captureSnapshotSchema.parse(JSON.parse(String(row.result_json))),
    };
  }

  saveSnapshotAndReceipt(
    snapshot: CaptureSnapshot,
    action: string,
    idempotencyKey: string,
    nowMs: number,
    authority?: CaptureAuthority,
  ): CaptureSnapshot {
    const value = captureSnapshotSchema.parse(snapshot);
    if (
      (action === "stop" || action === "keep") &&
      (value.state === "completed" || value.state === "partial_capture") &&
      !value.recordingSha256
    ) {
      throw new Error("finalized capture omitted its recording hash");
    }
    const transaction = withTransaction(this.database, () => {
      const repairOutcome = this.reconcileHistoricalRecoveryMarker(
        value,
        action,
        authority,
      );
      if (authority) this.replaceAuthority(value.sessionId, authority);
      const changes = this.database
        .prepare(
          `UPDATE capture_sessions SET
            title = CASE
              WHEN state <> 'recoverable' AND ? = 'recoverable'
                THEN 'Recover-' || title
              ELSE title
            END,
            state = ?, capture_mode = ?, capture_timeline_ms = ?,
            system_audio_healthy = ?, microphone_healthy = ?, partial_capture = ?,
            finalized_chunk_count = ?, event_count = ?, gap_count = ?,
            interruption_reason = ?, recording_sha256 = COALESCE(?, recording_sha256),
            journal_sha256 = COALESCE(?, journal_sha256), updated_at_ms = ?
          WHERE session_id = ? AND recovery_disposition IS NULL`,
        )
        .run(
          value.state,
          value.state,
          value.captureMode,
          value.captureTimelineMs,
          Number(value.systemAudioHealthy),
          Number(value.microphoneHealthy),
          Number(value.partialCapture),
          value.finalizedChunkCount,
          value.eventCount,
          value.gapCount,
          value.interruptionReason,
          value.recordingSha256,
          value.journalSha256 ?? null,
          nowMs,
          value.sessionId,
        ).changes;
      if (changes !== 1) throw new Error("capture session is not writable");
      this.database
        .prepare(
          `INSERT INTO capture_command_receipts (
            session_id, idempotency_key, action, result_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          value.sessionId,
          idempotencyKey,
          action,
          JSON.stringify(value),
          nowMs,
        );
      return { result: value, repairOutcome };
    });
    if (transaction.repairOutcome) {
      this.recoveryMarkerDiagnostics[transaction.repairOutcome] += 1;
    }
    return transaction.result;
  }

  private reconcileHistoricalRecoveryMarker(
    snapshot: CaptureSnapshot,
    action: string,
    authority: CaptureAuthority | undefined,
  ): keyof CaptureRecoveryMarkerDiagnostics | null {
    if (
      action !== "recover" ||
      (snapshot.state !== "recoverable" && snapshot.state !== "failed") ||
      snapshot.recordingSha256 !== null ||
      !snapshot.journalSha256 ||
      !authority ||
      authority.sessionId !== snapshot.sessionId ||
      authority.chunks.length !== snapshot.finalizedChunkCount
    ) {
      return null;
    }
    if (this.hasValidStopReceipt(snapshot.sessionId)) {
      return "unchanged";
    }
    const changes = this.database
      .prepare(
        `UPDATE capture_sessions
         SET recording_sha256 = NULL
         WHERE session_id = ?
           AND state IN ('recoverable', 'failed')
           AND recovery_disposition IS NULL
           AND recording_sha256 IS NOT NULL
           AND journal_sha256 = ?`,
      )
      .run(snapshot.sessionId, snapshot.journalSha256).changes;
    return changes === 1 ? "repaired" : "unchanged";
  }

  private hasValidStopReceipt(sessionId: string): boolean {
    const receipts = this.database
      .prepare(
        `SELECT result_json FROM capture_command_receipts
         WHERE session_id = ? AND action = 'stop'`,
      )
      .all(sessionId);
    return receipts.some((receipt) => {
      const parsed = captureSnapshotSchema.safeParse(
        JSON.parse(String(receipt.result_json)),
      );
      return (
        parsed.success &&
        parsed.data.sessionId === sessionId &&
        (parsed.data.state === "completed" ||
          parsed.data.state === "partial_capture") &&
        parsed.data.recordingSha256 !== null
      );
    });
  }

  saveSnapshot(snapshot: CaptureSnapshot, nowMs: number): CaptureSnapshot {
    const value = captureSnapshotSchema.parse(snapshot);
    const changes = this.database
      .prepare(
        `UPDATE capture_sessions SET
          title = CASE
            WHEN state <> 'recoverable' AND ? = 'recoverable'
              THEN 'Recover-' || title
            ELSE title
          END,
          state = ?, capture_mode = ?,
          capture_timeline_ms = ?, system_audio_healthy = ?,
          microphone_healthy = ?, partial_capture = ?,
          finalized_chunk_count = ?, event_count = ?, gap_count = ?,
          interruption_reason = ?, recording_sha256 = COALESCE(?, recording_sha256),
          journal_sha256 = COALESCE(?, journal_sha256), updated_at_ms = ?
        WHERE session_id = ? AND recovery_disposition IS NULL`,
      )
      .run(
        value.state,
        value.state,
        value.captureMode,
        value.captureTimelineMs,
        Number(value.systemAudioHealthy),
        Number(value.microphoneHealthy),
        Number(value.partialCapture),
        value.finalizedChunkCount,
        value.eventCount,
        value.gapCount,
        value.interruptionReason,
        value.recordingSha256,
        value.journalSha256 ?? null,
        nowMs,
        value.sessionId,
      ).changes;
    if (changes !== 1) throw new Error("capture session is not writable");
    return value;
  }

  private replaceAuthority(
    sessionId: string,
    authority: CaptureAuthority,
  ): void {
    this.database
      .prepare("DELETE FROM capture_events WHERE session_id = ?")
      .run(sessionId);
    this.database
      .prepare("DELETE FROM capture_chunks WHERE session_id = ?")
      .run(sessionId);
    this.database
      .prepare("DELETE FROM capture_tracks WHERE session_id = ?")
      .run(sessionId);
    const insertTrack = this.database.prepare(
      `INSERT INTO capture_tracks (
        session_id, kind, healthy, sample_rate, channels, format
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const track of authority.tracks) {
      insertTrack.run(
        sessionId,
        track.kind,
        Number(track.healthy),
        track.sampleRate,
        track.channels,
        track.format,
      );
    }
    const insertChunk = this.database.prepare(
      `INSERT INTO capture_chunks (
        session_id, track_kind, sequence, start_ms, end_ms,
        relative_path, bytes, sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chunk of authority.chunks) {
      insertChunk.run(
        sessionId,
        chunk.track,
        chunk.sequence,
        chunk.startMs,
        chunk.endMs,
        chunk.relativePath,
        chunk.bytes,
        chunk.sha256,
      );
    }
    const insertEvent = this.database.prepare(
      `INSERT INTO capture_events (
        session_id, sequence, monotonic_ms, kind, track_kind, reason
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const event of authority.events) {
      insertEvent.run(
        sessionId,
        event.sequence,
        event.monotonicMs,
        event.kind,
        event.track,
        event.reason,
      );
    }
  }

  find(sessionId: string): CaptureSnapshot | null {
    return this.findSession(sessionId)?.snapshot ?? null;
  }

  findSession(sessionId: string): StoredCaptureSession | null {
    const row = this.database
      .prepare("SELECT * FROM capture_sessions WHERE session_id = ?")
      .get(sessionId) as CaptureSessionRow | undefined;
    return row ? mapStoredSession(row) : null;
  }

  active(): CaptureSnapshot | null {
    return this.activeSession()?.snapshot ?? null;
  }

  activeSession(): StoredCaptureSession | null {
    const row = this.database
      .prepare(
        `SELECT * FROM capture_sessions
         WHERE state IN ('preparing', 'recording', 'paused', 'finalizing', 'partial_capture')
           AND recovery_disposition IS NULL
         ORDER BY updated_at_ms DESC LIMIT 1`,
      )
      .get() as CaptureSessionRow | undefined;
    return row ? mapStoredSession(row) : null;
  }

  sessionTitle(sessionId: string): string | null {
    const row = this.database
      .prepare("SELECT title FROM capture_sessions WHERE session_id = ?")
      .get(sessionId) as Pick<CaptureSessionRow, "title"> | undefined;
    return row ? captureTitleSchema.parse(row.title) : null;
  }

  listLibraryProjectionCandidates(
    cursor: CaptureLibraryProjectionCursor | null,
    limit: number,
  ): CaptureLibraryProjectionCandidate[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("capture library projection limit is invalid");
    }
    if (
      cursor &&
      (!Number.isSafeInteger(cursor.updatedAtMs) || cursor.updatedAtMs < 0)
    ) {
      throw new Error("capture library projection cursor is invalid");
    }
    const afterUpdatedAtMs = cursor?.updatedAtMs ?? -1;
    const afterSessionId = cursor?.sessionId ?? "";
    return this.database
      .prepare(
        `SELECT cs.session_id, cs.title, cs.updated_at_ms
         FROM capture_sessions cs
         WHERE cs.state IN ('completed', 'partial_capture')
           AND cs.recording_sha256 IS NOT NULL
           AND cs.journal_sha256 IS NOT NULL
           AND length(cs.recording_sha256) = 64
           AND cs.recording_sha256 NOT GLOB '*[^0-9a-f]*'
           AND length(cs.journal_sha256) = 64
           AND cs.journal_sha256 NOT GLOB '*[^0-9a-f]*'
           AND (
             cs.recovery_disposition = 'kept'
             OR (
               cs.recovery_disposition IS NULL
               AND EXISTS (
                 SELECT 1 FROM capture_command_receipts cr
                 WHERE cr.session_id = cs.session_id
                   AND cr.action = 'stop'
                   AND json_extract(cr.result_json, '$.sessionId') = cs.session_id
                   AND json_extract(cr.result_json, '$.state') IN ('completed', 'partial_capture')
                   AND json_extract(cr.result_json, '$.recordingSha256') = cs.recording_sha256
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM durable_receipts dr
             WHERE dr.idempotency_key = ? || cs.session_id
           )
           AND (
             cs.updated_at_ms > ?
             OR (cs.updated_at_ms = ? AND cs.session_id > ?)
           )
         ORDER BY cs.updated_at_ms, cs.session_id
         LIMIT ?`,
      )
      .all(
        CAPTURE_LIBRARY_RECEIPT_PREFIX,
        afterUpdatedAtMs,
        afterUpdatedAtMs,
        afterSessionId,
        limit,
      )
      .map((row) => {
        return {
          sessionId: String(row.session_id),
          displayName: captureTitleSchema.parse(row.title),
          cursor: {
            updatedAtMs: Number(row.updated_at_ms),
            sessionId: String(row.session_id),
          },
        };
      });
  }

  firstRecoverySessionId(): string | null {
    const row = this.database
      .prepare(
        `SELECT session_id FROM capture_sessions
         WHERE state IN ('recoverable', 'partial_capture', 'failed')
           AND recovery_disposition IS NULL AND recording_sha256 IS NULL
         ORDER BY updated_at_ms, session_id LIMIT 1`,
      )
      .get() as Pick<CaptureSessionRow, "session_id"> | undefined;
    return row?.session_id ?? null;
  }

  listRecoveryCandidates(): StoredCaptureRecovery[] {
    return this.database
      .prepare(
        `SELECT * FROM capture_sessions
         WHERE state IN ('preparing', 'recording', 'paused', 'finalizing', 'recoverable', 'partial_capture', 'failed')
           AND recovery_disposition IS NULL AND recording_sha256 IS NULL
         ORDER BY updated_at_ms, session_id`,
      )
      .all()
      .map((row) => mapStoredRecovery(row as unknown as CaptureSessionRow));
  }

  findRecoveryCandidate(sessionId: string): StoredCaptureRecovery | null {
    const row = this.database
      .prepare(
        `SELECT * FROM capture_sessions
         WHERE session_id = ?
           AND state IN ('preparing', 'recording', 'paused', 'finalizing', 'recoverable', 'partial_capture', 'failed')
           AND recovery_disposition IS NULL AND recording_sha256 IS NULL`,
      )
      .get(sessionId) as CaptureSessionRow | undefined;
    return row ? mapStoredRecovery(row) : null;
  }

  hasRecoveryAuthority(
    sessionId: string,
    finalizedChunkCount: number,
  ): boolean {
    if (
      !Number.isSafeInteger(finalizedChunkCount) ||
      finalizedChunkCount <= 0
    ) {
      return false;
    }
    const counts = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM capture_chunks WHERE session_id = ?) AS chunks,
           (SELECT COUNT(*) FROM capture_tracks WHERE session_id = ?) AS tracks`,
      )
      .get(sessionId, sessionId);
    return (
      Number(counts?.chunks ?? 0) === finalizedChunkCount &&
      Number(counts?.tracks ?? 0) > 0
    );
  }

  listDiscardedRecoverySessionIds(): string[] {
    return this.database
      .prepare(
        `SELECT session_id FROM capture_sessions
         WHERE recovery_disposition = 'discarded'
         ORDER BY updated_at_ms, session_id`,
      )
      .all()
      .map((row) => String(row.session_id));
  }

  renameSessionTitle(
    sessionId: string,
    rawTitle: string,
    nowMs: number,
  ): StoredCaptureSession {
    const title = captureTitleSchema.parse(rawTitle);
    return withTransaction(this.database, () => {
      const changes = this.database
        .prepare(
          `UPDATE capture_sessions SET title = ?, updated_at_ms = ?
           WHERE session_id = ? AND recovery_disposition IS NULL
             AND (
               state IN ('preparing', 'recording', 'paused', 'recoverable')
               OR (state IN ('partial_capture', 'failed') AND recording_sha256 IS NULL)
             )`,
        )
        .run(title, nowMs, sessionId).changes;
      if (changes !== 1) {
        throw new Error("capture session title is not editable");
      }
      const stored = this.findSession(sessionId);
      if (!stored) throw new Error("capture session disappeared after rename");
      return stored;
    });
  }

  setRecoveryDisposition(
    sessionId: string,
    disposition: "kept" | "discarded",
    nowMs: number,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE capture_sessions SET recovery_disposition = ?, updated_at_ms = ?
           WHERE session_id = ? AND recovery_disposition IS NULL
             AND state IN ('recoverable', 'partial_capture', 'failed')`,
        )
        .run(disposition, nowMs, sessionId).changes === 1
    );
  }

  discardRecoveryAndReceipt(
    sessionId: string,
    idempotencyKey: string,
    nowMs: number,
  ): CaptureSnapshot {
    return withTransaction(this.database, () => {
      const snapshot = this.find(sessionId);
      if (!snapshot) throw new Error("capture recovery does not exist");
      if (!this.setRecoveryDisposition(sessionId, "discarded", nowMs)) {
        throw new Error("capture recovery is not discardable");
      }
      this.database
        .prepare(
          `INSERT INTO capture_command_receipts (
            session_id, idempotency_key, action, result_json, created_at_ms
          ) VALUES (?, ?, 'discard', ?, ?)`,
        )
        .run(sessionId, idempotencyKey, JSON.stringify(snapshot), nowMs);
      return snapshot;
    });
  }

  keepRecoveryAndReceipt(
    sessionId: string,
    idempotencyKey: string,
    nowMs: number,
  ): CaptureSnapshot {
    return withTransaction(this.database, () => {
      const existing = this.find(sessionId);
      if (
        !existing ||
        !existing.journalSha256 ||
        existing.finalizedChunkCount === 0 ||
        !this.hasRecoveryAuthority(sessionId, existing.finalizedChunkCount)
      ) {
        throw new Error("validated capture recovery is unavailable");
      }
      const result = captureSnapshotSchema.parse({
        ...existing,
        state: "partial_capture",
        partialCapture: true,
        recordingSha256: existing.journalSha256,
      });
      const changes = this.database
        .prepare(
          `UPDATE capture_sessions SET state = 'partial_capture',
             partial_capture = 1, recording_sha256 = journal_sha256,
             recovery_disposition = 'kept', updated_at_ms = ?
           WHERE session_id = ? AND recovery_disposition IS NULL
             AND state IN ('recoverable', 'partial_capture')
             AND journal_sha256 IS NOT NULL`,
        )
        .run(nowMs, sessionId).changes;
      if (changes !== 1) throw new Error("capture recovery is not keepable");
      this.database
        .prepare(
          `INSERT INTO capture_command_receipts (
            session_id, idempotency_key, action, result_json, created_at_ms
          ) VALUES (?, ?, 'keep', ?, ?)`,
        )
        .run(sessionId, idempotencyKey, JSON.stringify(result), nowMs);
      return result;
    });
  }
}

function mapSnapshot(row: CaptureSessionRow): CaptureSnapshot {
  return captureSnapshotSchema.parse({
    sessionId: row.session_id,
    state: row.state,
    captureMode: row.capture_mode,
    captureTimelineMs: Number(row.capture_timeline_ms),
    systemAudioHealthy: Boolean(row.system_audio_healthy),
    microphoneHealthy: Boolean(row.microphone_healthy),
    partialCapture: Boolean(row.partial_capture),
    finalizedChunkCount: Number(row.finalized_chunk_count),
    eventCount: Number(row.event_count),
    gapCount: Number(row.gap_count),
    interruptionReason: row.interruption_reason,
    recordingSha256: row.recording_sha256,
    journalSha256: row.journal_sha256,
  });
}

function mapStoredSession(row: CaptureSessionRow): StoredCaptureSession {
  return {
    snapshot: mapSnapshot(row),
    title: captureTitleSchema.parse(row.title),
  };
}

function mapStoredRecovery(row: CaptureSessionRow): StoredCaptureRecovery {
  return {
    ...mapStoredSession(row),
    workspacePath: path.resolve(row.workspace_path),
  };
}
