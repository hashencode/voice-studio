import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  captureSnapshotSchema,
  type CaptureSnapshot,
} from "../../../shared/contracts";
import { withTransaction } from "../audio_database";
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
}

export class CaptureRepository {
  constructor(private readonly database: DatabaseSync) {}

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
    return withTransaction(this.database, () => {
      if (authority) this.replaceAuthority(value.sessionId, authority);
      const changes = this.database
        .prepare(
          `UPDATE capture_sessions SET
            state = ?, capture_mode = ?, capture_timeline_ms = ?,
            system_audio_healthy = ?, microphone_healthy = ?, partial_capture = ?,
            finalized_chunk_count = ?, event_count = ?, gap_count = ?,
            interruption_reason = ?, recording_sha256 = COALESCE(?, recording_sha256),
            journal_sha256 = COALESCE(?, journal_sha256), updated_at_ms = ?
          WHERE session_id = ? AND recovery_disposition IS NULL`,
        )
        .run(
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
      return value;
    });
  }

  saveSnapshot(snapshot: CaptureSnapshot, nowMs: number): CaptureSnapshot {
    const value = captureSnapshotSchema.parse(snapshot);
    const changes = this.database
      .prepare(
        `UPDATE capture_sessions SET state = ?, capture_mode = ?,
          capture_timeline_ms = ?, system_audio_healthy = ?,
          microphone_healthy = ?, partial_capture = ?,
          finalized_chunk_count = ?, event_count = ?, gap_count = ?,
          interruption_reason = ?, recording_sha256 = COALESCE(?, recording_sha256),
          journal_sha256 = COALESCE(?, journal_sha256), updated_at_ms = ?
        WHERE session_id = ? AND recovery_disposition IS NULL`,
      )
      .run(
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
    const row = this.database
      .prepare("SELECT * FROM capture_sessions WHERE session_id = ?")
      .get(sessionId) as CaptureSessionRow | undefined;
    return row ? mapSnapshot(row) : null;
  }

  active(): CaptureSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT * FROM capture_sessions
         WHERE state IN ('preparing', 'recording', 'paused', 'finalizing', 'partial_capture')
           AND recovery_disposition IS NULL
         ORDER BY updated_at_ms DESC LIMIT 1`,
      )
      .get() as CaptureSessionRow | undefined;
    return row ? mapSnapshot(row) : null;
  }

  listRecoveries(): CaptureSnapshot[] {
    return this.database
      .prepare(
        `SELECT * FROM capture_sessions
         WHERE state IN ('recoverable', 'partial_capture', 'failed')
           AND recovery_disposition IS NULL AND recording_sha256 IS NULL
         ORDER BY updated_at_ms, session_id`,
      )
      .all()
      .map((row) => mapSnapshot(row as unknown as CaptureSessionRow));
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
  ): void {
    withTransaction(this.database, () => {
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
        existing.finalizedChunkCount === 0
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
