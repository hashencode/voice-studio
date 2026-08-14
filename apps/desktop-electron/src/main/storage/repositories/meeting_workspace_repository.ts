import type { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  MeetingReviewState,
  MeetingSegment,
  MeetingSpeaker,
  MeetingSpeakerState,
  MeetingSummary,
  MeetingWorkspaceSnapshot,
} from "../../../shared/contracts";
import {
  parseAuthoritativeTranscript,
  type AuthoritativeTranscript,
} from "../../domain/workspace/authoritative_transcript";
import { withTransaction } from "../database";
import type { ElectronProfilePaths } from "../../profile/profile_paths";
import { sha256File } from "../../security/sha256_file";

export class WorkspaceConflictError extends Error {
  constructor(message = "meeting workspace changed; reload before editing") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

interface MaterializeCommand {
  meetingId: number;
  publicationId: number;
  attempt: number;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export class MeetingWorkspaceRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly profile: ElectronProfilePaths,
  ) {}

  materializePublishedResult(command: MaterializeCommand): number | null {
    const transcript = parseAuthoritativeTranscript(command.payload);
    if (!transcript) return null;
    return this.materialize(command, transcript);
  }

  listMeetings(options: {
    query: string;
    limit: number;
    offset: number;
  }): MeetingSummary[] {
    this.ensureAllActivePublicationsMaterialized();
    const query = options.query.trim();
    return this.database
      .prepare(
        `SELECT
          meetings.id AS meeting_id,
          meetings.display_name,
          meetings.duration_ms,
          meetings.created_at_ms,
          meeting_generations.id AS generation_id,
          meeting_generations.kind AS generation_kind,
          meeting_generations.partial_success,
          COALESCE((SELECT COUNT(*) FROM transcript_segments
            WHERE generation_id = meeting_generations.id), 0) AS segment_count,
          processing_jobs.state AS job_state,
          processing_jobs.cancel_requested_at_ms
        FROM meetings
        LEFT JOIN meeting_generations ON meeting_generations.id = meetings.active_generation_id
        LEFT JOIN processing_jobs ON processing_jobs.id = (
          SELECT latest.id FROM processing_jobs AS latest
          WHERE latest.meeting_id = meetings.id
          ORDER BY latest.updated_at_ms DESC, latest.id DESC LIMIT 1
        )
        WHERE (? = '' OR lower(meetings.display_name) LIKE lower(?) ESCAPE '\\')
        ORDER BY meetings.updated_at_ms DESC, meetings.id DESC
        LIMIT ? OFFSET ?`,
      )
      .all(query, `%${escapeLike(query)}%`, options.limit, options.offset)
      .map(mapSummary);
  }

  openMeeting(meetingId: number): MeetingWorkspaceSnapshot | null {
    this.ensureActivePublicationMaterialized(meetingId);
    const summaryRow = this.summaryRow(meetingId);
    if (!summaryRow) return null;
    const summary = mapSummary(summaryRow);
    const revision = this.headRevision(meetingId);
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
      canUndo: this.hasUndo(meetingId),
      canRedo: this.hasRedo(meetingId),
    };
  }

  searchTranscript(options: {
    meetingId: number;
    query: string;
    limit: number;
  }): MeetingSegment[] {
    this.ensureActivePublicationMaterialized(options.meetingId);
    const generation = this.database
      .prepare("SELECT active_generation_id FROM meetings WHERE id = ?")
      .get(options.meetingId);
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
    meetingId: number;
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
          "SELECT stable_key, text, text_source, review_state FROM transcript_segments WHERE id = ? AND generation_id = ? AND meeting_id = ?",
        )
        .get(command.segmentId, command.generationId, command.meetingId);
      if (!row)
        throw new WorkspaceConflictError(
          "transcript segment is no longer active",
        );
      this.database
        .prepare(
          "UPDATE transcript_revisions SET invalidated_at_ms = ? WHERE meeting_id = ? AND generation_id = ? AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL",
        )
        .run(command.nowMs, command.meetingId, command.generationId);
      if (String(row.text) !== command.text) {
        this.database
          .prepare(
            `INSERT INTO transcript_revisions (
              meeting_id, generation_id, segment_stable_key, previous_text, previous_text_source,
              previous_review_state, next_text, next_text_source, next_review_state,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'reviewed', ?)`,
          )
          .run(
            command.meetingId,
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
      this.bumpRevision(command.meetingId, command.nowMs);
    });
  }

  undo(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
    nowMs: number,
  ): boolean {
    return withTransaction(this.database, () => {
      this.assertMutation({ meetingId, generationId, expectedRevision });
      const revision = this.database
        .prepare(
          "SELECT * FROM transcript_revisions WHERE meeting_id = ? AND generation_id = ? AND reverted_at_ms IS NULL AND invalidated_at_ms IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(meetingId, generationId);
      if (!revision) return false;
      const updated = this.database
        .prepare(
          `UPDATE transcript_segments SET text = ?, text_source = ?, review_state = ?, updated_at_ms = ?
           WHERE meeting_id = ? AND generation_id = ?
             AND stable_key = ?`,
        )
        .run(
          String(revision.previous_text),
          String(revision.previous_text_source),
          String(revision.previous_review_state),
          nowMs,
          meetingId,
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
      this.bumpRevision(meetingId, nowMs);
      return true;
    });
  }

  redo(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
    nowMs: number,
  ): boolean {
    return withTransaction(this.database, () => {
      this.assertMutation({ meetingId, generationId, expectedRevision });
      const revision = this.database
        .prepare(
          "SELECT * FROM transcript_revisions WHERE meeting_id = ? AND generation_id = ? AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL ORDER BY reverted_at_ms DESC, id DESC LIMIT 1",
        )
        .get(meetingId, generationId);
      if (!revision) return false;
      const updated = this.database
        .prepare(
          `UPDATE transcript_segments SET text = ?, text_source = ?, review_state = ?, updated_at_ms = ?
           WHERE meeting_id = ? AND generation_id = ?
             AND stable_key = ?`,
        )
        .run(
          String(revision.next_text),
          String(revision.next_text_source),
          String(revision.next_review_state),
          nowMs,
          meetingId,
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
      this.bumpRevision(meetingId, nowMs);
      return true;
    });
  }

  renameSpeaker(command: {
    meetingId: number;
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
          "UPDATE meeting_speakers SET display_name = ?, source = 'manual', updated_at_ms = ? WHERE id = ? AND generation_id = ? AND meeting_id = ? AND merged_into_speaker_id IS NULL",
        )
        .run(
          command.name,
          command.nowMs,
          command.speakerId,
          command.generationId,
          command.meetingId,
        );
      if (result.changes !== 1)
        throw new WorkspaceConflictError("speaker is no longer active");
      this.bumpRevision(command.meetingId, command.nowMs);
    });
  }

  mergeSpeakers(command: {
    meetingId: number;
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
            `SELECT COUNT(*) AS count FROM meeting_speakers WHERE meeting_id = ? AND generation_id = ?
             AND merged_into_speaker_id IS NULL AND id IN (?, ${placeholders})`,
          )
          .get(
            command.meetingId,
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
          `UPDATE meeting_speakers SET merged_into_speaker_id = ?, source = 'manual', updated_at_ms = ?
           WHERE generation_id = ? AND id IN (${placeholders})`,
        )
        .run(
          command.targetSpeakerId,
          command.nowMs,
          command.generationId,
          ...ids,
        );
      this.bumpRevision(command.meetingId, command.nowMs);
    });
  }

  assignSpeaker(command: {
    meetingId: number;
    generationId: number;
    segmentId: number;
    state: MeetingSpeakerState;
    speakerId: number | null;
    expectedRevision: number;
    nowMs: number;
  }): void {
    withTransaction(this.database, () => {
      this.assertMutation(command);
      if (command.speakerId !== null) {
        const speaker = this.database
          .prepare(
            "SELECT id FROM meeting_speakers WHERE id = ? AND meeting_id = ? AND generation_id = ? AND merged_into_speaker_id IS NULL",
          )
          .get(command.speakerId, command.meetingId, command.generationId);
        if (!speaker)
          throw new WorkspaceConflictError("speaker is no longer active");
      }
      const updated = this.database
        .prepare(
          "UPDATE transcript_segments SET speaker_state = ?, speaker_id = ?, speaker_source = 'manual', updated_at_ms = ? WHERE id = ? AND meeting_id = ? AND generation_id = ?",
        )
        .run(
          command.state,
          command.speakerId,
          command.nowMs,
          command.segmentId,
          command.meetingId,
          command.generationId,
        );
      if (updated.changes !== 1)
        throw new WorkspaceConflictError(
          "transcript segment is no longer active",
        );
      this.bumpRevision(command.meetingId, command.nowMs);
    });
  }

  async resolvePlayback(
    meetingId: number,
  ): Promise<{ mediaPath: string; durationMs: number } | null> {
    const row = this.database
      .prepare(
        `SELECT meetings.media_path, meetings.duration_ms,
          media_authorities.normalized_path, media_authorities.content_sha256
         FROM meetings
         JOIN media_authorities ON media_authorities.id = meetings.media_authority_id
         WHERE meetings.id = ?`,
      )
      .get(meetingId);
    if (!row) return null;
    const mediaPath = resolve(String(row.media_path));
    if (mediaPath !== resolve(String(row.normalized_path)))
      throw new Error("meeting media authority path mismatch");
    const entry = lstatSync(mediaPath);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("meeting media authority is not a regular file");
    const mediaRoot = realpathSync(this.profile.mediaDirectory);
    const canonicalMedia = realpathSync(mediaPath);
    const child = relative(mediaRoot, canonicalMedia);
    if (!child || child.startsWith("..") || isAbsolute(child))
      throw new Error("meeting media authority escapes the private profile");
    if ((await sha256File(canonicalMedia)) !== String(row.content_sha256))
      throw new Error("meeting media authority identity mismatch");
    return { mediaPath: canonicalMedia, durationMs: Number(row.duration_ms) };
  }

  private materialize(
    command: MaterializeCommand,
    transcript: AuthoritativeTranscript,
  ): number {
    const existing = this.database
      .prepare("SELECT id FROM meeting_generations WHERE publication_id = ?")
      .get(command.publicationId);
    if (existing) return Number(existing.id);
    const meeting = this.database
      .prepare("SELECT active_generation_id FROM meetings WHERE id = ?")
      .get(command.meetingId);
    if (!meeting) throw new Error("published meeting is missing");
    const previousGenerationId =
      meeting.active_generation_id == null
        ? null
        : Number(meeting.active_generation_id);
    const previousSpeakers =
      previousGenerationId === null
        ? []
        : this.database
            .prepare("SELECT * FROM meeting_speakers WHERE generation_id = ?")
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
        `INSERT INTO meeting_generations (
          meeting_id, publication_id, kind, attempt, partial_success, created_at_ms,
          reconciliation_state, supersedes_generation_id
        ) VALUES (?, ?, 'formal', ?, ?, ?, ?, ?)`,
      )
      .run(
        command.meetingId,
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
          "INSERT INTO meeting_speakers (meeting_id, generation_id, stable_key, display_name, source, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          command.meetingId,
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
            "UPDATE meeting_speakers SET merged_into_speaker_id = ?, source = 'manual' WHERE id = ?",
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
      let reviewState: MeetingReviewState = "unreviewed";
      let speakerState: MeetingSpeakerState = segment.speakerState;
      let speakerSource: "machine" | "manual" = "machine";
      let speakerId = segment.speakerKey
        ? (speakerIdByKey.get(segment.speakerKey) ?? null)
        : null;
      const machineSpeakerId = speakerId;
      if (previous) {
        reviewState = String(previous.review_state) as MeetingReviewState;
        if (String(previous.text_source) === "manual") {
          text = String(previous.text);
          textSource = "manual";
        }
        if (String(previous.speaker_source) === "manual") {
          speakerState = String(previous.speaker_state) as MeetingSpeakerState;
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
            meeting_id, generation_id, stable_key, sequence_id, machine_text, text,
            text_source, start_ms, end_ms, review_state, speaker_state, speaker_id,
            speaker_source, machine_speaker_id, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.meetingId,
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
        "INSERT OR IGNORE INTO workspace_heads (meeting_id, revision, updated_at_ms) VALUES (?, 0, ?)",
      )
      .run(command.meetingId, command.createdAtMs);
    if (!manualOverlayCannotReconcile) {
      this.database
        .prepare(
          "UPDATE meetings SET active_generation_id = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(generationId, command.createdAtMs, command.meetingId);
      if (previousGenerationId !== null)
        this.bumpRevision(command.meetingId, command.createdAtMs);
    }
    return generationId;
  }

  private ensureAllActivePublicationsMaterialized(): void {
    const rows = this.database
      .prepare(
        "SELECT id FROM meetings WHERE active_publication_id IS NOT NULL AND active_generation_id IS NULL",
      )
      .all();
    for (const row of rows)
      this.ensureActivePublicationMaterialized(Number(row.id));
  }

  private ensureActivePublicationMaterialized(meetingId: number): void {
    const row = this.database
      .prepare(
        `SELECT meetings.active_generation_id, result_publications.id AS publication_id,
          result_publications.attempt, result_publications.payload_json, result_publications.created_at_ms
         FROM meetings LEFT JOIN result_publications ON result_publications.id = meetings.active_publication_id
         WHERE meetings.id = ?`,
      )
      .get(meetingId);
    if (!row || row.active_generation_id != null || row.publication_id == null)
      return;
    const payload = JSON.parse(String(row.payload_json)) as Record<
      string,
      unknown
    >;
    withTransaction(this.database, () => {
      this.materializePublishedResult({
        meetingId,
        publicationId: Number(row.publication_id),
        attempt: Number(row.attempt),
        payload,
        createdAtMs: Number(row.created_at_ms),
      });
    });
  }

  private summaryRow(meetingId: number): Record<string, unknown> | undefined {
    return this.database
      .prepare(
        `SELECT meetings.id AS meeting_id, meetings.display_name, meetings.duration_ms,
          meetings.created_at_ms, meeting_generations.id AS generation_id,
          meeting_generations.kind AS generation_kind, meeting_generations.partial_success,
          COALESCE((SELECT COUNT(*) FROM transcript_segments WHERE generation_id = meeting_generations.id), 0) AS segment_count,
          processing_jobs.state AS job_state, processing_jobs.cancel_requested_at_ms
         FROM meetings
         LEFT JOIN meeting_generations ON meeting_generations.id = meetings.active_generation_id
         LEFT JOIN processing_jobs ON processing_jobs.id = (
           SELECT latest.id FROM processing_jobs AS latest WHERE latest.meeting_id = meetings.id
           ORDER BY latest.updated_at_ms DESC, latest.id DESC LIMIT 1
         ) WHERE meetings.id = ?`,
      )
      .get(meetingId);
  }

  private segments(generationId: number): MeetingSegment[] {
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
        `SELECT transcript_segments.*, meeting_speakers.display_name AS speaker_name
         FROM transcript_segments
         LEFT JOIN meeting_speakers ON meeting_speakers.id = transcript_segments.speaker_id
         WHERE ${where}
         ORDER BY transcript_segments.sequence_id, transcript_segments.start_ms, transcript_segments.id
         ${suffix}`,
      )
      .all(...parameters);
  }

  private speakers(generationId: number): MeetingSpeaker[] {
    return this.database
      .prepare(
        "SELECT * FROM meeting_speakers WHERE generation_id = ? ORDER BY merged_into_speaker_id IS NOT NULL, id",
      )
      .all(generationId)
      .map((row) => ({
        id: Number(row.id),
        stableKey: String(row.stable_key),
        displayName: String(row.display_name),
        source: String(row.source) as MeetingSpeaker["source"],
        mergedIntoSpeakerId:
          row.merged_into_speaker_id == null
            ? null
            : Number(row.merged_into_speaker_id),
      }));
  }

  private headRevision(meetingId: number): number {
    return Number(
      this.database
        .prepare("SELECT revision FROM workspace_heads WHERE meeting_id = ?")
        .get(meetingId)?.revision ?? 0,
    );
  }

  private assertMutation(command: {
    meetingId: number;
    generationId: number;
    expectedRevision: number;
  }): void {
    const row = this.database
      .prepare(
        "SELECT meetings.active_generation_id, workspace_heads.revision FROM meetings JOIN workspace_heads ON workspace_heads.meeting_id = meetings.id WHERE meetings.id = ?",
      )
      .get(command.meetingId);
    if (
      !row ||
      Number(row.active_generation_id) !== command.generationId ||
      Number(row.revision) !== command.expectedRevision
    ) {
      throw new WorkspaceConflictError();
    }
  }

  private assertHead(meetingId: number, expectedRevision: number): void {
    if (this.headRevision(meetingId) !== expectedRevision)
      throw new WorkspaceConflictError();
  }

  private bumpRevision(meetingId: number, nowMs: number): void {
    const updated = this.database
      .prepare(
        "UPDATE workspace_heads SET revision = revision + 1, updated_at_ms = ? WHERE meeting_id = ?",
      )
      .run(nowMs, meetingId);
    if (updated.changes !== 1)
      throw new WorkspaceConflictError("meeting workspace head is missing");
  }

  private hasUndo(meetingId: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM transcript_revisions
           WHERE meeting_id = ?
             AND generation_id = (SELECT active_generation_id FROM meetings WHERE id = ?)
             AND reverted_at_ms IS NULL AND invalidated_at_ms IS NULL LIMIT 1`,
        )
        .get(meetingId, meetingId),
    );
  }

  private hasRedo(meetingId: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM transcript_revisions
           WHERE meeting_id = ?
             AND generation_id = (SELECT active_generation_id FROM meetings WHERE id = ?)
             AND reverted_at_ms IS NOT NULL AND invalidated_at_ms IS NULL LIMIT 1`,
        )
        .get(meetingId, meetingId),
    );
  }
}

function mapSummary(row: Record<string, unknown>): MeetingSummary {
  const state = row.job_state == null ? "queued" : String(row.job_state);
  return {
    meetingId: Number(row.meeting_id),
    displayName: String(row.display_name),
    durationMs: Number(row.duration_ms),
    createdAtMs: Number(row.created_at_ms),
    processingState:
      Number(row.partial_success ?? 0) === 1
        ? "partial-success"
        : state === "running" && row.cancel_requested_at_ms != null
          ? "canceling"
          : (state as MeetingSummary["processingState"]),
    generationId: row.generation_id == null ? null : Number(row.generation_id),
    generationKind:
      row.generation_kind == null
        ? null
        : (String(row.generation_kind) as MeetingSummary["generationKind"]),
    segmentCount: Number(row.segment_count),
  };
}

function mapSegment(row: Record<string, unknown>): MeetingSegment {
  return {
    id: Number(row.id),
    stableKey: String(row.stable_key),
    sequenceId: Number(row.sequence_id),
    text: String(row.text),
    machineText: String(row.machine_text),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    reviewState: String(row.review_state) as MeetingReviewState,
    speakerState: String(row.speaker_state) as MeetingSpeakerState,
    speakerId: row.speaker_id == null ? null : Number(row.speaker_id),
    speakerName: row.speaker_name == null ? null : String(row.speaker_name),
    speakerSource: String(
      row.speaker_source,
    ) as MeetingSegment["speakerSource"],
  };
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
