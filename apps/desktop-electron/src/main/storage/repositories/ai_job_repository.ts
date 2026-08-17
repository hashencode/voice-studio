import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";

import type { AudioAiOutput } from "../../domain/audio-intelligence/provider_output";
import {
  AiProviderFailure,
  parseRemoteAiEndpoint,
} from "../../domain/audio-intelligence/provider_security";
import { withTransaction } from "../audio_database";

export interface AiProviderSettingsRecord {
  providerId: "deepseek" | "openai-compatible";
  modelId: string;
  endpoint: string;
}

export interface AiConsentIdentity {
  version: 1;
  providerId: string;
  endpointOrigin: string;
  endpointIdentitySha256: string;
  transcriptScopeSha256: string;
}

export interface AiJobRecord {
  id: number;
  audioId: number;
  generationId: number;
  providerId: string;
  modelId: string;
  endpoint: string;
  endpointOrigin: string;
  endpointIdentitySha256: string;
  transcriptScopeSha256: string;
  templateId: string;
  state: "queued" | "running" | "completed" | "failed" | "interrupted";
  attempt: number;
  revision: number;
  errorCode: string | null;
}

export interface AiNoteRecord {
  id: number;
  output: AudioAiOutput;
}

export interface AiNoteSnapshotRecord {
  noteId: number;
  schemaVersion: "audio_intelligence_output/v1";
  suggestedTitle: string | null;
  audioType: string | null;
  items: Array<{
    insightId: number;
    kind: string;
    body: string;
    evidence: Array<{ segmentId: number; startMs: number; endMs: number }>;
    actionOwner: string | null;
    actionDueAtMs: number | null;
  }>;
}

export interface AiTranscriptScopeSource {
  audioTitle: string;
  segments: Array<{
    id: number;
    startMs: number;
    endMs: number;
    text: string;
    speakerState: string;
  }>;
}

export class AiJobRepository {
  constructor(private readonly database: DatabaseSync) {}

  loadSettings(): AiProviderSettingsRecord {
    const row = this.database
      .prepare(
        "SELECT provider_id, model_id, endpoint FROM ai_provider_settings WHERE id = 1",
      )
      .get();
    if (!row) throw new Error("AI provider settings are unavailable");
    return {
      providerId: String(
        row.provider_id,
      ) as AiProviderSettingsRecord["providerId"],
      modelId: String(row.model_id),
      endpoint: String(row.endpoint),
    };
  }

  saveSettings(settings: AiProviderSettingsRecord, nowMs = Date.now()): void {
    const modelId = settings.modelId.trim();
    if (modelId.length === 0 || [...modelId].length > 256) {
      throw new AiProviderFailure(
        "AI_INVALID_CONFIGURATION",
        "AI model id is invalid",
      );
    }
    const endpoint = parseRemoteAiEndpoint(settings.endpoint);
    if (
      settings.providerId === "deepseek" &&
      (endpoint.origin !== "https://api.deepseek.com" ||
        endpoint.baseUrl !== "https://api.deepseek.com")
    ) {
      throw new AiProviderFailure(
        "AI_INVALID_CONFIGURATION",
        "DeepSeek endpoint cannot be changed",
      );
    }
    this.database
      .prepare(
        `UPDATE ai_provider_settings SET provider_id = ?, model_id = ?, endpoint = ?,
         updated_at_ms = ? WHERE id = 1`,
      )
      .run(settings.providerId, modelId, endpoint.baseUrl, nowMs);
  }

  enqueue(
    command: {
      audioId: number;
      generationId: number;
      providerId: string;
      modelId: string;
      endpoint: string;
      endpointOrigin: string;
      endpointIdentitySha256: string;
      transcriptScopeSha256: string;
      templateId: string;
      idempotencyKey: string;
      nowMs: number;
    },
    consent: AiConsentIdentity | null,
  ): AiJobRecord {
    const existing = this.byIdempotency(command.idempotencyKey);
    if (existing) {
      this.assertJobIdentity(existing, command);
      return existing;
    }
    if (
      !consent ||
      consent.version !== 1 ||
      consent.providerId !== command.providerId ||
      consent.endpointOrigin !== command.endpointOrigin ||
      consent.endpointIdentitySha256 !== command.endpointIdentitySha256 ||
      consent.transcriptScopeSha256 !== command.transcriptScopeSha256
    ) {
      throw new AiProviderFailure(
        "AI_CONSENT_REQUIRED",
        "consent identity does not match this transcript request",
      );
    }
    return withTransaction(this.database, () => {
      if (
        !this.database
          .prepare(
            "SELECT id FROM audio_generations WHERE id = ? AND audio_id = ?",
          )
          .get(command.generationId, command.audioId)
      ) {
        throw new AiProviderFailure(
          "AI_INVALID_OUTPUT",
          "audio transcript is unavailable",
        );
      }
      this.database
        .prepare(
          `INSERT INTO ai_consents (
            audio_id, generation_id, provider_id, endpoint, endpoint_origin, endpoint_identity_sha256,
            transcript_scope_sha256, consent_version, granted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(audio_id, generation_id, provider_id, endpoint_identity_sha256,
            transcript_scope_sha256, consent_version) DO NOTHING`,
        )
        .run(
          command.audioId,
          command.generationId,
          command.providerId,
          command.endpoint,
          command.endpointOrigin,
          command.endpointIdentitySha256,
          command.transcriptScopeSha256,
          command.nowMs,
        );
      const consentRow = this.database
        .prepare(
          `SELECT id FROM ai_consents WHERE audio_id = ? AND generation_id = ?
           AND provider_id = ? AND endpoint_identity_sha256 = ? AND transcript_scope_sha256 = ?
           AND consent_version = 1`,
        )
        .get(
          command.audioId,
          command.generationId,
          command.providerId,
          command.endpointIdentitySha256,
          command.transcriptScopeSha256,
        );
      const inserted = this.database
        .prepare(
          `INSERT INTO ai_jobs (
            audio_id, generation_id, consent_id, idempotency_key, provider_id,
            model_id, endpoint, endpoint_origin, endpoint_identity_sha256, transcript_scope_sha256, template_id,
            state, attempt, revision, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)`,
        )
        .run(
          command.audioId,
          command.generationId,
          Number(consentRow!.id),
          command.idempotencyKey,
          command.providerId,
          command.modelId,
          command.endpoint,
          command.endpointOrigin,
          command.endpointIdentitySha256,
          command.transcriptScopeSha256,
          command.templateId,
          command.nowMs,
          command.nowMs,
        );
      const jobId = Number(inserted.lastInsertRowid);
      this.database
        .prepare(
          `INSERT INTO ai_command_receipts (
            idempotency_key, job_id, action, expected_attempt, result_attempt, created_at_ms
          ) VALUES (?, ?, 'generate', NULL, 0, ?)`,
        )
        .run(command.idempotencyKey, jobId, command.nowMs);
      return this.requireJob(jobId);
    });
  }

  claim(jobId: number, nowMs: number): AiJobRecord {
    return withTransaction(this.database, () => {
      const current = this.requireJob(jobId);
      if (current.state === "running" || current.state === "completed")
        return current;
      if (current.state !== "queued") {
        throw new AiProviderFailure(
          "AI_ATTEMPT_CONFLICT",
          "AI job cannot be claimed",
        );
      }
      const attempt = Math.max(1, current.attempt);
      this.database
        .prepare(
          `UPDATE ai_jobs SET state = 'running', attempt = ?, revision = revision + 1,
           error_code = NULL, started_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(attempt, nowMs, nowMs, jobId);
      return this.requireJob(jobId);
    });
  }

  publish(
    jobId: number,
    attempt: number,
    output: AudioAiOutput,
    nowMs: number,
  ): AiNoteRecord {
    return withTransaction(this.database, () => {
      const current = this.requireJob(jobId);
      const existing = this.noteForJob(jobId);
      if (current.state === "completed" && existing) {
        if (JSON.stringify(existing.output) !== JSON.stringify(output)) {
          throw new AiProviderFailure(
            "AI_ATTEMPT_CONFLICT",
            "completed AI note identity changed",
          );
        }
        return existing;
      }
      if (current.state !== "running" || current.attempt !== attempt) {
        throw new AiProviderFailure(
          "AI_ATTEMPT_CONFLICT",
          "late AI output was rejected",
        );
      }
      const inserted = this.database
        .prepare(
          `INSERT INTO ai_notes (
            job_id, audio_id, generation_id, output_schema_version,
            suggested_title, audio_type, output_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          current.audioId,
          current.generationId,
          output.schemaVersion,
          output.suggestedTitle,
          output.audioType,
          JSON.stringify(output),
          nowMs,
        );
      const noteId = Number(inserted.lastInsertRowid);
      const insertInsight = this.database.prepare(
        `INSERT INTO ai_insights (
          note_id, kind, body, action_owner, action_due_at_ms, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertEvidence = this.database.prepare(
        `INSERT INTO ai_evidence_links (
          insight_id, segment_id, start_ms, end_ms
        ) VALUES (?, ?, ?, ?)`,
      );
      output.items.forEach((item, index) => {
        const insight = insertInsight.run(
          noteId,
          item.kind,
          item.body,
          item.actionOwner,
          item.actionDueAtMs,
          index,
        );
        for (const evidence of item.evidence) {
          insertEvidence.run(
            Number(insight.lastInsertRowid),
            evidence.segmentId,
            evidence.startMs,
            evidence.endMs,
          );
        }
      });
      this.database
        .prepare(
          `UPDATE ai_jobs SET state = 'completed', revision = revision + 1,
           error_code = NULL, completed_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'running' AND attempt = ?`,
        )
        .run(nowMs, nowMs, jobId, attempt);
      return { id: noteId, output };
    });
  }

  markFailed(
    jobId: number,
    attempt: number,
    code: string,
    nowMs: number,
  ): AiJobRecord {
    this.assertOneChange(
      this.database
        .prepare(
          `UPDATE ai_jobs SET state = 'failed', error_code = ?, revision = revision + 1,
           updated_at_ms = ? WHERE id = ? AND state = 'running' AND attempt = ?`,
        )
        .run(code, nowMs, jobId, attempt),
    );
    return this.requireJob(jobId);
  }

  reconcileInterrupted(nowMs: number): number {
    return Number(
      this.database
        .prepare(
          `UPDATE ai_jobs SET state = 'interrupted', error_code = 'AI_PROCESS_INTERRUPTED',
           revision = revision + 1, updated_at_ms = ? WHERE state IN ('queued', 'running')`,
        )
        .run(nowMs).changes,
    );
  }

  retry(command: {
    jobId: number;
    expectedAttempt: number;
    idempotencyKey: string;
    nowMs: number;
  }): AiJobRecord {
    const replay = this.retryReceiptReplay(command);
    if (replay) return replay;
    return withTransaction(this.database, () => {
      const current = this.requireJob(command.jobId);
      if (
        current.attempt !== command.expectedAttempt ||
        !["failed", "interrupted"].includes(current.state)
      ) {
        throw new AiProviderFailure(
          "AI_ATTEMPT_CONFLICT",
          "AI retry attempt is stale",
        );
      }
      const nextAttempt = current.attempt + 1;
      this.database
        .prepare(
          `UPDATE ai_jobs SET state = 'queued', attempt = ?, revision = revision + 1,
           error_code = NULL, started_at_ms = NULL, completed_at_ms = NULL, updated_at_ms = ?
           WHERE id = ? AND attempt = ? AND state IN ('failed', 'interrupted')`,
        )
        .run(
          nextAttempt,
          command.nowMs,
          command.jobId,
          command.expectedAttempt,
        );
      this.database
        .prepare(
          `INSERT INTO ai_command_receipts (
            idempotency_key, job_id, action, expected_attempt, result_attempt, created_at_ms
          ) VALUES (?, ?, 'retry', ?, ?, ?)`,
        )
        .run(
          command.idempotencyKey,
          command.jobId,
          command.expectedAttempt,
          nextAttempt,
          command.nowMs,
        );
      return this.requireJob(command.jobId);
    });
  }

  retryReceiptReplay(command: {
    jobId: number;
    expectedAttempt: number;
    idempotencyKey: string;
  }): AiJobRecord | null {
    const receipt = this.database
      .prepare(
        `SELECT job_id, action, expected_attempt, result_attempt
         FROM ai_command_receipts WHERE idempotency_key = ?`,
      )
      .get(command.idempotencyKey);
    if (receipt) {
      if (
        Number(receipt.job_id) !== command.jobId ||
        receipt.action !== "retry" ||
        Number(receipt.expected_attempt) !== command.expectedAttempt ||
        Number(receipt.result_attempt) !== command.expectedAttempt + 1
      ) {
        throw new AiProviderFailure(
          "AI_ATTEMPT_CONFLICT",
          "AI retry receipt identity changed",
        );
      }
      return this.requireJob(command.jobId);
    }
    return null;
  }

  latestForAudio(audioId: number): AiJobRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM ai_jobs WHERE audio_id = ? ORDER BY updated_at_ms DESC, id DESC LIMIT 1",
      )
      .get(audioId);
    return row ? mapJob(row) : null;
  }

  getJob(jobId: number): AiJobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM ai_jobs WHERE id = ?")
      .get(jobId);
    return row ? mapJob(row) : null;
  }

  jobForIdempotency(idempotencyKey: string): AiJobRecord | null {
    return this.byIdempotency(idempotencyKey);
  }

  settingsRevision(): number {
    const row = this.database
      .prepare("SELECT updated_at_ms FROM ai_provider_settings WHERE id = 1")
      .get();
    return Number(row?.updated_at_ms ?? 0);
  }

  noteSnapshot(jobId: number): AiNoteSnapshotRecord | null {
    const note = this.database
      .prepare(
        `SELECT id, output_schema_version, suggested_title, audio_type
         FROM ai_notes WHERE job_id = ?`,
      )
      .get(jobId);
    if (!note) return null;
    const rows = this.database
      .prepare(
        `SELECT i.id, i.kind, i.body, i.action_owner, i.action_due_at_ms,
                e.id AS evidence_id, e.segment_id, e.start_ms, e.end_ms
         FROM ai_insights AS i
         LEFT JOIN ai_evidence_links AS e ON e.insight_id = i.id
         WHERE i.note_id = ?
         ORDER BY i.sort_order, i.id, e.id`,
      )
      .all(Number(note.id));
    const items: AiNoteSnapshotRecord["items"] = [];
    const itemsById = new Map<number, AiNoteSnapshotRecord["items"][number]>();
    for (const row of rows) {
      const insightId = Number(row.id);
      let item = itemsById.get(insightId);
      if (!item) {
        item = {
          insightId,
          kind: String(row.kind),
          body: String(row.body),
          evidence: [],
          actionOwner:
            row.action_owner == null ? null : String(row.action_owner),
          actionDueAtMs:
            row.action_due_at_ms == null ? null : Number(row.action_due_at_ms),
        };
        itemsById.set(insightId, item);
        items.push(item);
      }
      if (row.evidence_id != null) {
        item.evidence.push({
          segmentId: Number(row.segment_id),
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
        });
      }
    }
    return {
      noteId: Number(note.id),
      schemaVersion: String(
        note.output_schema_version,
      ) as "audio_intelligence_output/v1",
      suggestedTitle:
        note.suggested_title == null ? null : String(note.suggested_title),
      audioType: note.audio_type == null ? null : String(note.audio_type),
      items,
    };
  }

  transcriptScopeSource(
    audioId: number,
    generationId: number,
    limit: number,
  ): AiTranscriptScopeSource | null {
    const audio = this.database
      .prepare(
        `SELECT display_name FROM audio_items
         WHERE id = ? AND active_generation_id = ?`,
      )
      .get(audioId, generationId);
    if (!audio) return null;
    return {
      audioTitle: String(audio.display_name),
      segments: this.database
        .prepare(
          `SELECT id, start_ms, end_ms, text, speaker_state
           FROM transcript_segments WHERE audio_id = ? AND generation_id = ?
           ORDER BY sequence_id, start_ms, id LIMIT ?`,
        )
        .all(audioId, generationId, limit)
        .map((row) => ({
          id: Number(row.id),
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          text: String(row.text),
          speakerState: String(row.speaker_state),
        })),
    };
  }

  noteForJob(jobId: number): AiNoteRecord | null {
    const row = this.database
      .prepare("SELECT id, output_json FROM ai_notes WHERE job_id = ?")
      .get(jobId);
    return row
      ? {
          id: Number(row.id),
          output: JSON.parse(String(row.output_json)) as AudioAiOutput,
        }
      : null;
  }

  private byIdempotency(key: string): AiJobRecord | null {
    const row = this.database
      .prepare("SELECT * FROM ai_jobs WHERE idempotency_key = ?")
      .get(key);
    return row ? mapJob(row) : null;
  }

  private requireJob(jobId: number): AiJobRecord {
    const row = this.database
      .prepare("SELECT * FROM ai_jobs WHERE id = ?")
      .get(jobId);
    if (!row)
      throw new AiProviderFailure(
        "AI_ATTEMPT_CONFLICT",
        "AI job is unavailable",
      );
    return mapJob(row);
  }

  private assertJobIdentity(
    existing: AiJobRecord,
    command: Omit<
      AiJobRecord,
      "id" | "state" | "attempt" | "revision" | "errorCode"
    >,
  ): void {
    if (
      existing.audioId !== command.audioId ||
      existing.generationId !== command.generationId ||
      existing.providerId !== command.providerId ||
      existing.modelId !== command.modelId ||
      existing.endpoint !== command.endpoint ||
      existing.endpointOrigin !== command.endpointOrigin ||
      existing.endpointIdentitySha256 !== command.endpointIdentitySha256 ||
      existing.transcriptScopeSha256 !== command.transcriptScopeSha256 ||
      existing.templateId !== command.templateId
    ) {
      throw new AiProviderFailure(
        "AI_ATTEMPT_CONFLICT",
        "AI idempotency identity changed",
      );
    }
  }

  private assertOneChange(result: StatementResultingChanges): void {
    if (result.changes !== 1)
      throw new AiProviderFailure("AI_ATTEMPT_CONFLICT", "AI attempt is stale");
  }
}

function mapJob(row: Record<string, unknown>): AiJobRecord {
  return {
    id: Number(row.id),
    audioId: Number(row.audio_id),
    generationId: Number(row.generation_id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    endpoint: String(row.endpoint),
    endpointOrigin: String(row.endpoint_origin),
    endpointIdentitySha256: String(row.endpoint_identity_sha256),
    transcriptScopeSha256: String(row.transcript_scope_sha256),
    templateId: String(row.template_id),
    state: String(row.state) as AiJobRecord["state"],
    attempt: Number(row.attempt),
    revision: Number(row.revision),
    errorCode: row.error_code == null ? null : String(row.error_code),
  };
}
