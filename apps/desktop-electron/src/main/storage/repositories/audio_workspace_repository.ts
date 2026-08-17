import type { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  AudioReviewState,
  AudioSegment,
  AudioSpeaker,
  AudioSpeakerState,
  AudioSummary,
  AudioWorkspaceSnapshot,
} from "../../../shared/contracts";
import {
  parseAuthoritativeTranscript,
  type AuthoritativeTranscript,
} from "../../domain/workspace/authoritative_transcript";
import { withTransaction } from "../audio_database";
import type { AudioProfilePaths } from "../../profile/profile_paths";
import { sha256File } from "../../security/sha256_file";

export class WorkspaceConflictError extends Error {
  constructor(message = "audio workspace changed; reload before editing") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

interface MaterializeCommand {
  audioId: number;
  publicationId: number;
  attempt: number;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export class AudioWorkspaceRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly profile: AudioProfilePaths,
  ) {}

  materializePublishedResult(command: MaterializeCommand): number | null {
    const transcript = parseAuthoritativeTranscript(command.payload);
    if (!transcript) return null;
    return this.materialize(command, transcript);
  }

  listAudios(options: {
    query: string;
    limit: number;
    offset: number;
  }): AudioSummary[] {
    this.ensureAllActivePublicationsMaterialized();
    const query = options.query.trim();
    return this.database
      .prepare(
        `SELECT
          audio_items.id AS audio_id,
          audio_items.display_name,
          audio_items.duration_ms,
          audio_items.created_at_ms,
          audio_generations.id AS generation_id,
          audio_generations.kind AS generation_kind,
          audio_generations.partial_success,
          COALESCE((SELECT COUNT(*) FROM transcript_segments
            WHERE generation_id = audio_generations.id), 0) AS segment_count,
          processing_jobs.state AS job_state,
          processing_jobs.cancel_requested_at_ms
        FROM audio_items
        LEFT JOIN audio_generations ON audio_generations.id = audio_items.active_generation_id
        LEFT JOIN processing_jobs ON processing_jobs.id = (
          SELECT latest.id FROM processing_jobs AS latest
          WHERE latest.audio_id = audio_items.id
          ORDER BY latest.updated_at_ms DESC, latest.id DESC LIMIT 1
        )
        WHERE (? = '' OR lower(audio_items.display_name) LIKE lower(?) ESCAPE '\\')
        ORDER BY audio_items.updated_at_ms DESC, audio_items.id DESC
        LIMIT ? OFFSET ?`,
      )
      .all(query, `%${escapeLike(query)}%`, options.limit, options.offset)
      .map(mapSummary);
  }

  openAudio(audioId: number): AudioWorkspaceSnapshot | null {
    this.ensureActivePublicationMaterialized(audioId);
    const summaryRow = this.summaryRow(audioId);
    if (!summaryRow) return null;
    const summary = mapSummary(summaryRow);
    const revision = this.headRevision(audioId);
    if (summary.generationId === null) {
      return {
        revision,
        summary,
        segments: [],
        speakers: [],
        canUndo: false,
        canRedo: false,
      };
    }
    return {
      revision,
      summary,
      segments: this.segments(summary.generationId),
      speakers: this.speakers(summary.generationId),
      canUndo: this.hasUndo(audioId),
      canRedo: this.hasRedo(audioId),
    };
  }

  searchTranscript(options: {
    audioId: number;
    query: string;
    limit: number;
  }): AudioSegment[] {
    this.ensureActivePublicationMaterialized(options.audioId);
    const generation = this.database
      .prepare("SELECT active_generation_id FROM audio_items WHERE id = ?")
      .get(options.audioId);
    if (generation?.active_generation_id == null) return [];
    return this.segmentRows(
      `transcript_segments.generation_id = ? AND lower(transcript_segments.text) LIKE lower(?) ESCAPE '\\'`,
      [
        Number(generation.active_generation_id),
        `%${escapeLike(options.query.trim())}%`,
        options.limit,
      ],
      "LIMIT ?",
    ).map(mapSegment);
  }

  editSegment(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    text: string;
    expectedRevision: number;
    nowMs: number;
  }): void {
    withTransaction(this.database, () => {
      this.assertMutation(command);
      const row = this.database
        .prepare(
          "SELECT stable_key, text, text_source, review_state FROM transcript_segments WHERE id = ? AND generation_id = ? AND audio_id = ?",
        )
        .get(command.segmentId, command.generationId, command.audioId);
      if (!row)
        throw new WorkspaceConflictError(
          "transcript segment is no longer active",
        );
      this.database
        .prepare(
          "UPDATE transcript_revisions SET invalidated_at_ms = ? WHERE audio_id = ? AND generation_id = ? AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL",
        )
        .run(command.nowMs, command.audioId, command.generationId);
      if (String(row.text) !== command.text) {
        this.database
          .prepare(
            `INSERT INTO transcript_revisions (
              audio_id, generation_id, segment_stable_key, previous_text, previous_text_source,
              previous_review_state, next_text, next_text_source, next_review_state,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'reviewed', ?)`,
          )
          .run(
            command.audioId,
            command.generationId,
            String(row.stable_key),
            String(row.text),
            String(row.text_source),
            String(row.review_state),
            command.text,
            command.nowMs,
          );
      }
      this.database
        .prepare(
          "UPDATE transcript_segments SET text = ?, text_source = 'manual', review_state = 'reviewed', updated_at_ms = ? WHERE id = ?",
        )
        .run(command.text, command.nowMs, command.segmentId);
      this.bumpRevision(command.audioId, command.nowMs);
    });
  }

  undo(
    audioId: number,
    generationId: number,
    expectedRevision: number,
    nowMs: number,
  ): boolean {
    return withTransaction(this.database, () => {
      this.assertMutation({ audioId, generationId, expectedRevision });
      const revision = this.database
        .prepare(
          "SELECT * FROM transcript_revisions WHERE audio_id = ? AND generation_id = ? AND reverted_at_ms IS NULL AND invalidated_at_ms IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(audioId, generationId);
      if (!revision) return false;
      const updated = this.database
        .prepare(
          `UPDATE transcript_segments SET text = ?, text_source = ?, review_state = ?, updated_at_ms = ?
           WHERE audio_id = ? AND generation_id = ?
             AND stable_key = ?`,
        )
        .run(
          String(revision.previous_text),
          String(revision.previous_text_source),
          String(revision.previous_review_state),
          nowMs,
          audioId,
          generationId,
          String(revision.segment_stable_key),
        );
      if (updated.changes !== 1)
        throw new WorkspaceConflictError(
          "edited segment is absent from the active generation",
        );
      this.database
        .prepare(
          "UPDATE transcript_revisions SET reverted_at_ms = ? WHERE id = ?",
        )
        .run(nowMs, Number(revision.id));
      this.bumpRevision(audioId, nowMs);
      return true;
    });
  }

  redo(
    audioId: number,
    generationId: number,
    expectedRevision: number,
    nowMs: number,
  ): boolean {
    return withTransaction(this.database, () => {
      this.assertMutation({ audioId, generationId, expectedRevision });
      const revision = this.database
        .prepare(
          "SELECT * FROM transcript_revisions WHERE audio_id = ? AND generation_id = ? AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL ORDER BY reverted_at_ms DESC, id DESC LIMIT 1",
        )
        .get(audioId, generationId);
      if (!revision) return false;
      const updated = this.database
        .prepare(
          `UPDATE transcript_segments SET text = ?, text_source = ?, review_state = ?, updated_at_ms = ?
           WHERE audio_id = ? AND generation_id = ?
             AND stable_key = ?`,
        )
        .run(
          String(revision.next_text),
          String(revision.next_text_source),
          String(revision.next_review_state),
          nowMs,
          audioId,
          generationId,
          String(revision.segment_stable_key),
        );
      if (updated.changes !== 1)
        throw new WorkspaceConflictError(
          "edited segment is absent from the active generation",
        );
      this.database
        .prepare(
          "UPDATE transcript_revisions SET reverted_at_ms = NULL WHERE id = ?",
        )
        .run(Number(revision.id));
      this.bumpRevision(audioId, nowMs);
      return true;
    });
  }

  renameSpeaker(command: {
    audioId: number;
    generationId: number;
    speakerId: number;
    name: string;
    expectedRevision: number;
    nowMs: number;
  }): void {
    withTransaction(this.database, () => {
      this.assertMutation(command);
      const result = this.database
        .prepare(
          "UPDATE audio_speakers SET display_name = ?, source = 'manual', updated_at_ms = ? WHERE id = ? AND generation_id = ? AND audio_id = ? AND merged_into_speaker_id IS NULL",
        )
        .run(
          command.name,
          command.nowMs,
          command.speakerId,
          command.generationId,
          command.audioId,
        );
      if (result.changes !== 1)
        throw new WorkspaceConflictError("speaker is no longer active");
      this.bumpRevision(command.audioId, command.nowMs);
    });
  }

  mergeSpeakers(command: {
    audioId: number;
    generationId: number;
    targetSpeakerId: number;
    sourceSpeakerIds: number[];
    expectedRevision: number;
    nowMs: number;
  }): void {
    withTransaction(this.database, () => {
      this.assertMutation(command);
      const ids = [...new Set(command.sourceSpeakerIds)].filter(
        (id) => id !== command.targetSpeakerId,
      );
      if (ids.length === 0)
        throw new WorkspaceConflictError(
          "speaker merge requires a distinct source",
        );
      const placeholders = ids.map(() => "?").join(",");
      const activeCount = Number(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM audio_speakers WHERE audio_id = ? AND generation_id = ?
             AND merged_into_speaker_id IS NULL AND id IN (?, ${placeholders})`,
          )
          .get(
            command.audioId,
            command.generationId,
            command.targetSpeakerId,
            ...ids,
          )?.count ?? 0,
      );
      if (activeCount !== ids.length + 1)
        throw new WorkspaceConflictError("speaker merge selection is stale");
      this.database
        .prepare(
          `UPDATE transcript_segments SET speaker_id = ?, speaker_state = 'assigned', speaker_source = 'manual', updated_at_ms = ?
           WHERE generation_id = ? AND speaker_id IN (${placeholders})`,
        )
        .run(
          command.targetSpeakerId,
          command.nowMs,
          command.generationId,
          ...ids,
        );
      this.database
        .prepare(
          `UPDATE audio_speakers SET merged_into_speaker_id = ?, source = 'manual', updated_at_ms = ?
           WHERE generation_id = ? AND id IN (${placeholders})`,
        )
        .run(
          command.targetSpeakerId,
          command.nowMs,
          command.generationId,
          ...ids,
        );
      this.bumpRevision(command.audioId, command.nowMs);
    });
  }

  assignSpeaker(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    state: AudioSpeakerState;
    speakerId: number | null;
    expectedRevision: number;
    nowMs: number;
  }): void {
    withTransaction(this.database, () => {
      this.assertMutation(command);
      if (command.speakerId !== null) {
        const speaker = this.database
          .prepare(
            "SELECT id FROM audio_speakers WHERE id = ? AND audio_id = ? AND generation_id = ? AND merged_into_speaker_id IS NULL",
          )
          .get(command.speakerId, command.audioId, command.generationId);
        if (!speaker)
          throw new WorkspaceConflictError("speaker is no longer active");
      }
      const updated = this.database
        .prepare(
          "UPDATE transcript_segments SET speaker_state = ?, speaker_id = ?, speaker_source = 'manual', updated_at_ms = ? WHERE id = ? AND audio_id = ? AND generation_id = ?",
        )
        .run(
          command.state,
          command.speakerId,
          command.nowMs,
          command.segmentId,
          command.audioId,
          command.generationId,
        );
      if (updated.changes !== 1)
        throw new WorkspaceConflictError(
          "transcript segment is no longer active",
        );
      this.bumpRevision(command.audioId, command.nowMs);
    });
  }

  async resolvePlayback(
    audioId: number,
  ): Promise<{ mediaPath: string; durationMs: number } | null> {
    const row = this.database
      .prepare(
        `SELECT audio_items.media_path, audio_items.duration_ms,
          media_authorities.normalized_path, media_authorities.content_sha256
         FROM audio_items
         JOIN media_authorities ON media_authorities.id = audio_items.media_authority_id
         WHERE audio_items.id = ?`,
      )
      .get(audioId);
    if (!row) return null;
    const mediaPath = resolve(String(row.media_path));
    if (mediaPath !== resolve(String(row.normalized_path)))
      throw new Error("audio media authority path mismatch");
    const entry = lstatSync(mediaPath);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("audio media authority is not a regular file");
    const mediaRoot = realpathSync(this.profile.mediaDirectory);
    const canonicalMedia = realpathSync(mediaPath);
    const child = relative(mediaRoot, canonicalMedia);
    if (!child || child.startsWith("..") || isAbsolute(child))
      throw new Error("audio media authority escapes the private profile");
    if ((await sha256File(canonicalMedia)) !== String(row.content_sha256))
      throw new Error("audio media authority identity mismatch");
    return { mediaPath: canonicalMedia, durationMs: Number(row.duration_ms) };
  }

  private materialize(
    command: MaterializeCommand,
    transcript: AuthoritativeTranscript,
  ): number {
    const existing = this.database
      .prepare("SELECT id FROM audio_generations WHERE publication_id = ?")
      .get(command.publicationId);
    if (existing) return Number(existing.id);
    const audio = this.database
      .prepare("SELECT active_generation_id FROM audio_items WHERE id = ?")
      .get(command.audioId);
    if (!audio) throw new Error("published audio is missing");
    const previousGenerationId =
      audio.active_generation_id == null
        ? null
        : Number(audio.active_generation_id);
    const previousSpeakers =
      previousGenerationId === null
        ? []
        : this.database
            .prepare("SELECT * FROM audio_speakers WHERE generation_id = ?")
            .all(previousGenerationId);
    const previousSegments =
      previousGenerationId === null
        ? []
        : this.database
            .prepare(
              "SELECT * FROM transcript_segments WHERE generation_id = ?",
            )
            .all(previousGenerationId);
    const incomingSegmentKeys = new Set(
      transcript.segments.map((segment) => segment.stableKey),
    );
    const incomingSpeakerKeys = new Set(
      transcript.segments.flatMap((segment) =>
        segment.speakerKey ? [segment.speakerKey] : [],
      ),
    );
    const manualOverlayCannotReconcile =
      previousSegments.some(
        (row) =>
          (String(row.text_source) === "manual" ||
            String(row.speaker_source) === "manual") &&
          !incomingSegmentKeys.has(String(row.stable_key)),
      ) ||
      previousSpeakers.some(
        (row) =>
          (String(row.source) === "manual" ||
            row.merged_into_speaker_id != null) &&
          !incomingSpeakerKeys.has(String(row.stable_key)),
      );
    const reconciliationState = manualOverlayCannotReconcile
      ? "pending"
      : "active";
    const generation = this.database
      .prepare(
        `INSERT INTO audio_generations (
          audio_id, publication_id, kind, attempt, partial_success, created_at_ms,
          reconciliation_state, supersedes_generation_id
        ) VALUES (?, ?, 'formal', ?, ?, ?, ?, ?)`,
      )
      .run(
        command.audioId,
        command.publicationId,
        command.attempt,
        transcript.partialSuccess ? 1 : 0,
        command.createdAtMs,
        reconciliationState,
        previousGenerationId,
      );
    const generationId = Number(generation.lastInsertRowid);
    const previousSpeakerById = new Map(
      previousSpeakers.map((row) => [Number(row.id), row]),
    );
    const previousSpeakerByKey = new Map(
      previousSpeakers.map((row) => [String(row.stable_key), row]),
    );
    const previousSegmentByKey = new Map(
      previousSegments.map((row) => [String(row.stable_key), row]),
    );

    const speakerKeys = new Set(
      transcript.segments.flatMap((segment) =>
        segment.speakerKey ? [segment.speakerKey] : [],
      ),
    );
    if (!manualOverlayCannotReconcile) {
      for (const row of previousSpeakers)
        speakerKeys.add(String(row.stable_key));
    }
    const speakerIdByKey = new Map<string, number>();
    let speakerIndex = 0;
    for (const stableKey of speakerKeys) {
      speakerIndex += 1;
      const previous = manualOverlayCannotReconcile
        ? undefined
        : previousSpeakerByKey.get(stableKey);
      const inserted = this.database
        .prepare(
          "INSERT INTO audio_speakers (audio_id, generation_id, stable_key, display_name, source, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          command.audioId,
          generationId,
          stableKey,
          previous && String(previous.source) === "manual"
            ? String(previous.display_name)
            : `说话人 ${speakerIndex}`,
          previous && String(previous.source) === "manual"
            ? "manual"
            : "machine",
          command.createdAtMs,
          command.createdAtMs,
        );
      speakerIdByKey.set(stableKey, Number(inserted.lastInsertRowid));
    }
    for (const previous of manualOverlayCannotReconcile
      ? []
      : previousSpeakers) {
      if (previous.merged_into_speaker_id == null) continue;
      const target = previousSpeakerById.get(
        Number(previous.merged_into_speaker_id),
      );
      if (!target) continue;
      const sourceId = speakerIdByKey.get(String(previous.stable_key));
      const targetId = speakerIdByKey.get(String(target.stable_key));
      if (sourceId && targetId) {
        this.database
          .prepare(
            "UPDATE audio_speakers SET merged_into_speaker_id = ?, source = 'manual' WHERE id = ?",
          )
          .run(targetId, sourceId);
      }
    }

    for (const segment of transcript.segments) {
      const previous = manualOverlayCannotReconcile
        ? undefined
        : previousSegmentByKey.get(segment.stableKey);
      let text = segment.text;
      let textSource: "machine" | "manual" = "machine";
      let reviewState: AudioReviewState = "unreviewed";
      let speakerState: AudioSpeakerState = segment.speakerState;
      let speakerSource: "machine" | "manual" = "machine";
      let speakerId = segment.speakerKey
        ? (speakerIdByKey.get(segment.speakerKey) ?? null)
        : null;
      const machineSpeakerId = speakerId;
      if (previous) {
        reviewState = String(previous.review_state) as AudioReviewState;
        if (String(previous.text_source) === "manual") {
          text = String(previous.text);
          textSource = "manual";
        }
        if (String(previous.speaker_source) === "manual") {
          speakerState = String(previous.speaker_state) as AudioSpeakerState;
          speakerSource = "manual";
          const oldSpeaker =
            previous.speaker_id == null
              ? null
              : previousSpeakerById.get(Number(previous.speaker_id));
          const oldTarget =
            oldSpeaker?.merged_into_speaker_id == null
              ? oldSpeaker
              : previousSpeakerById.get(
                  Number(oldSpeaker.merged_into_speaker_id),
                );
          speakerId = oldTarget
            ? (speakerIdByKey.get(String(oldTarget.stable_key)) ?? null)
            : null;
        } else if (segment.speakerKey) {
          const oldMachineSpeaker = previousSpeakerByKey.get(
            segment.speakerKey,
          );
          if (oldMachineSpeaker?.merged_into_speaker_id != null) {
            const target = previousSpeakerById.get(
              Number(oldMachineSpeaker.merged_into_speaker_id),
            );
            if (target) {
              speakerId = speakerIdByKey.get(String(target.stable_key)) ?? null;
              speakerState = "assigned";
              speakerSource = "manual";
            }
          }
        }
      }
      this.database
        .prepare(
          `INSERT INTO transcript_segments (
            audio_id, generation_id, stable_key, sequence_id, machine_text, text,
            text_source, start_ms, end_ms, review_state, speaker_state, speaker_id,
            speaker_source, machine_speaker_id, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.audioId,
          generationId,
          segment.stableKey,
          segment.sequenceId,
          segment.text,
          text,
          textSource,
          segment.startMs,
          segment.endMs,
          reviewState,
          speakerState,
          speakerId,
          speakerSource,
          machineSpeakerId,
          command.createdAtMs,
          command.createdAtMs,
        );
    }
    this.database
      .prepare(
        "INSERT OR IGNORE INTO workspace_heads (audio_id, revision, updated_at_ms) VALUES (?, 0, ?)",
      )
      .run(command.audioId, command.createdAtMs);
    if (!manualOverlayCannotReconcile) {
      this.database
        .prepare(
          "UPDATE audio_items SET active_generation_id = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(generationId, command.createdAtMs, command.audioId);
      if (previousGenerationId !== null)
        this.bumpRevision(command.audioId, command.createdAtMs);
    }
    return generationId;
  }

  private ensureAllActivePublicationsMaterialized(): void {
    const rows = this.database
      .prepare(
        "SELECT id FROM audio_items WHERE active_publication_id IS NOT NULL AND active_generation_id IS NULL",
      )
      .all();
    for (const row of rows)
      this.ensureActivePublicationMaterialized(Number(row.id));
  }

  private ensureActivePublicationMaterialized(audioId: number): void {
    const row = this.database
      .prepare(
        `SELECT audio_items.active_generation_id, result_publications.id AS publication_id,
          result_publications.attempt, result_publications.payload_json, result_publications.created_at_ms
         FROM audio_items LEFT JOIN result_publications ON result_publications.id = audio_items.active_publication_id
         WHERE audio_items.id = ?`,
      )
      .get(audioId);
    if (!row || row.active_generation_id != null || row.publication_id == null)
      return;
    const payload = JSON.parse(String(row.payload_json)) as Record<
      string,
      unknown
    >;
    withTransaction(this.database, () => {
      this.materializePublishedResult({
        audioId,
        publicationId: Number(row.publication_id),
        attempt: Number(row.attempt),
        payload,
        createdAtMs: Number(row.created_at_ms),
      });
    });
  }

  private summaryRow(audioId: number): Record<string, unknown> | undefined {
    return this.database
      .prepare(
        `SELECT audio_items.id AS audio_id, audio_items.display_name, audio_items.duration_ms,
          audio_items.created_at_ms, audio_generations.id AS generation_id,
          audio_generations.kind AS generation_kind, audio_generations.partial_success,
          COALESCE((SELECT COUNT(*) FROM transcript_segments WHERE generation_id = audio_generations.id), 0) AS segment_count,
          processing_jobs.state AS job_state, processing_jobs.cancel_requested_at_ms
         FROM audio_items
         LEFT JOIN audio_generations ON audio_generations.id = audio_items.active_generation_id
         LEFT JOIN processing_jobs ON processing_jobs.id = (
           SELECT latest.id FROM processing_jobs AS latest WHERE latest.audio_id = audio_items.id
           ORDER BY latest.updated_at_ms DESC, latest.id DESC LIMIT 1
         ) WHERE audio_items.id = ?`,
      )
      .get(audioId);
  }

  private segments(generationId: number): AudioSegment[] {
    return this.segmentRows(
      "transcript_segments.generation_id = ?",
      [generationId],
      "",
    ).map(mapSegment);
  }

  private segmentRows(
    where: string,
    parameters: Array<string | number | bigint | Uint8Array | null>,
    suffix: string,
  ): Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT transcript_segments.*, audio_speakers.display_name AS speaker_name
         FROM transcript_segments
         LEFT JOIN audio_speakers ON audio_speakers.id = transcript_segments.speaker_id
         WHERE ${where}
         ORDER BY transcript_segments.sequence_id, transcript_segments.start_ms, transcript_segments.id
         ${suffix}`,
      )
      .all(...parameters);
  }

  private speakers(generationId: number): AudioSpeaker[] {
    return this.database
      .prepare(
        "SELECT * FROM audio_speakers WHERE generation_id = ? ORDER BY merged_into_speaker_id IS NOT NULL, id",
      )
      .all(generationId)
      .map((row) => ({
        id: Number(row.id),
        stableKey: String(row.stable_key),
        displayName: String(row.display_name),
        source: String(row.source) as AudioSpeaker["source"],
        mergedIntoSpeakerId:
          row.merged_into_speaker_id == null
            ? null
            : Number(row.merged_into_speaker_id),
      }));
  }

  private headRevision(audioId: number): number {
    return Number(
      this.database
        .prepare("SELECT revision FROM workspace_heads WHERE audio_id = ?")
        .get(audioId)?.revision ?? 0,
    );
  }

  private assertMutation(command: {
    audioId: number;
    generationId: number;
    expectedRevision: number;
  }): void {
    const row = this.database
      .prepare(
        "SELECT audio_items.active_generation_id, workspace_heads.revision FROM audio_items JOIN workspace_heads ON workspace_heads.audio_id = audio_items.id WHERE audio_items.id = ?",
      )
      .get(command.audioId);
    if (
      !row ||
      Number(row.active_generation_id) !== command.generationId ||
      Number(row.revision) !== command.expectedRevision
    ) {
      throw new WorkspaceConflictError();
    }
  }

  private assertHead(audioId: number, expectedRevision: number): void {
    if (this.headRevision(audioId) !== expectedRevision)
      throw new WorkspaceConflictError();
  }

  private bumpRevision(audioId: number, nowMs: number): void {
    const updated = this.database
      .prepare(
        "UPDATE workspace_heads SET revision = revision + 1, updated_at_ms = ? WHERE audio_id = ?",
      )
      .run(nowMs, audioId);
    if (updated.changes !== 1)
      throw new WorkspaceConflictError("audio workspace head is missing");
  }

  private hasUndo(audioId: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM transcript_revisions
           WHERE audio_id = ?
             AND generation_id = (SELECT active_generation_id FROM audio_items WHERE id = ?)
             AND reverted_at_ms IS NULL AND invalidated_at_ms IS NULL LIMIT 1`,
        )
        .get(audioId, audioId),
    );
  }

  private hasRedo(audioId: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM transcript_revisions
           WHERE audio_id = ?
             AND generation_id = (SELECT active_generation_id FROM audio_items WHERE id = ?)
             AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL LIMIT 1`,
        )
        .get(audioId, audioId),
    );
  }
}

function mapSummary(row: Record<string, unknown>): AudioSummary {
  const state = row.job_state == null ? "queued" : String(row.job_state);
  return {
    audioId: Number(row.audio_id),
    displayName: String(row.display_name),
    durationMs: Number(row.duration_ms),
    createdAtMs: Number(row.created_at_ms),
    processingState:
      Number(row.partial_success ?? 0) === 1
        ? "partial-success"
        : state === "running" && row.cancel_requested_at_ms != null
          ? "canceling"
          : (state as AudioSummary["processingState"]),
    generationId: row.generation_id == null ? null : Number(row.generation_id),
    generationKind:
      row.generation_kind == null
        ? null
        : (String(row.generation_kind) as AudioSummary["generationKind"]),
    segmentCount: Number(row.segment_count),
  };
}

function mapSegment(row: Record<string, unknown>): AudioSegment {
  return {
    id: Number(row.id),
    stableKey: String(row.stable_key),
    sequenceId: Number(row.sequence_id),
    text: String(row.text),
    machineText: String(row.machine_text),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    reviewState: String(row.review_state) as AudioReviewState,
    speakerState: String(row.speaker_state) as AudioSpeakerState,
    speakerId: row.speaker_id == null ? null : Number(row.speaker_id),
    speakerName: row.speaker_name == null ? null : String(row.speaker_name),
    speakerSource: String(row.speaker_source) as AudioSegment["speakerSource"],
  };
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
