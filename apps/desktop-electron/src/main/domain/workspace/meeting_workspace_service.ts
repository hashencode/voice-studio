import {
  assignMeetingSpeakerRequestSchema,
  editMeetingSegmentRequestSchema,
  listMeetingsRequestSchema,
  meetingHistoryRequestSchema,
  mergeMeetingSpeakersRequestSchema,
  renameMeetingSpeakerRequestSchema,
  searchTranscriptRequestSchema,
  type MeetingWorkspaceSnapshot,
} from "../../../shared/contracts";
import { MeetingWorkspaceRepository } from "../../storage/repositories/meeting_workspace_repository";

export class MeetingWorkspaceService {
  constructor(
    private readonly repository: MeetingWorkspaceRepository,
    private readonly now: () => number = Date.now,
  ) {}

  listMeetings(
    options: { query?: string; limit?: number; offset?: number } = {},
  ) {
    const parsed = listMeetingsRequestSchema.parse({
      query: options.query ?? "",
      limit: options.limit ?? 200,
      offset: options.offset ?? 0,
    });
    return this.repository.listMeetings({
      ...parsed,
      query: parsed.query.trim(),
    });
  }

  openMeeting(meetingId: number): MeetingWorkspaceSnapshot | null {
    if (!Number.isSafeInteger(meetingId) || meetingId <= 0)
      throw new Error("meeting identity is invalid");
    return this.repository.openMeeting(meetingId);
  }

  searchTranscript(options: {
    meetingId: number;
    query: string;
    limit?: number;
  }) {
    const normalized = options.query.trim();
    if (normalized.length === 0) return [];
    const parsed = searchTranscriptRequestSchema.parse({
      meetingId: options.meetingId,
      query: normalized,
      limit: options.limit ?? 200,
    });
    return this.repository.searchTranscript(parsed);
  }

  editSegment(command: {
    meetingId: number;
    generationId: number;
    segmentId: number;
    text: string;
    expectedRevision: number;
  }): MeetingWorkspaceSnapshot {
    const parsed = editMeetingSegmentRequestSchema.parse({
      ...command,
      text: command.text.trim(),
    });
    this.repository.editSegment({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.meetingId);
  }

  undo(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
  ): MeetingWorkspaceSnapshot {
    const parsed = meetingHistoryRequestSchema.parse({
      meetingId,
      generationId,
      expectedRevision,
    });
    this.repository.undo(
      parsed.meetingId,
      parsed.generationId,
      parsed.expectedRevision,
      this.now(),
    );
    return this.requireSnapshot(meetingId);
  }

  redo(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
  ): MeetingWorkspaceSnapshot {
    const parsed = meetingHistoryRequestSchema.parse({
      meetingId,
      generationId,
      expectedRevision,
    });
    this.repository.redo(
      parsed.meetingId,
      parsed.generationId,
      parsed.expectedRevision,
      this.now(),
    );
    return this.requireSnapshot(meetingId);
  }

  renameSpeaker(command: {
    meetingId: number;
    generationId: number;
    speakerId: number;
    name: string;
    expectedRevision: number;
  }): MeetingWorkspaceSnapshot {
    const parsed = renameMeetingSpeakerRequestSchema.parse({
      ...command,
      name: command.name.trim(),
    });
    this.repository.renameSpeaker({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.meetingId);
  }

  mergeSpeakers(command: {
    meetingId: number;
    generationId: number;
    targetSpeakerId: number;
    sourceSpeakerIds: number[];
    expectedRevision: number;
  }): MeetingWorkspaceSnapshot {
    const parsed = mergeMeetingSpeakersRequestSchema.parse(command);
    this.repository.mergeSpeakers({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.meetingId);
  }

  assignSpeaker(command: {
    meetingId: number;
    generationId: number;
    segmentId: number;
    state: "assigned" | "overlap" | "unknown";
    speakerId: number | null;
    expectedRevision: number;
  }): MeetingWorkspaceSnapshot {
    const parsed = assignMeetingSpeakerRequestSchema.parse(command);
    this.repository.assignSpeaker({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.meetingId);
  }

  private requireSnapshot(meetingId: number): MeetingWorkspaceSnapshot {
    const snapshot = this.repository.openMeeting(meetingId);
    if (!snapshot) throw new Error("meeting workspace is unavailable");
    return snapshot;
  }
}
