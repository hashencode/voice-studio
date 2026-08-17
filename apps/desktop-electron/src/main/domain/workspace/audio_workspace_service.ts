import {
  assignAudioSpeakerRequestSchema,
  editAudioSegmentRequestSchema,
  listAudiosRequestSchema,
  audioHistoryRequestSchema,
  mergeAudioSpeakersRequestSchema,
  renameAudioSpeakerRequestSchema,
  searchTranscriptRequestSchema,
  type AudioWorkspaceSnapshot,
} from "../../../shared/contracts";
import { AudioWorkspaceRepository } from "../../storage/repositories/audio_workspace_repository";

export class AudioWorkspaceService {
  constructor(
    private readonly repository: AudioWorkspaceRepository,
    private readonly now: () => number = Date.now,
  ) {}

  listAudios(
    options: { query?: string; limit?: number; offset?: number } = {},
  ) {
    const parsed = listAudiosRequestSchema.parse({
      query: options.query ?? "",
      limit: options.limit ?? 200,
      offset: options.offset ?? 0,
    });
    return this.repository.listAudios({
      ...parsed,
      query: parsed.query.trim(),
    });
  }

  openAudio(audioId: number): AudioWorkspaceSnapshot | null {
    if (!Number.isSafeInteger(audioId) || audioId <= 0)
      throw new Error("audio identity is invalid");
    return this.repository.openAudio(audioId);
  }

  searchTranscript(options: {
    audioId: number;
    query: string;
    limit?: number;
  }) {
    const normalized = options.query.trim();
    if (normalized.length === 0) return [];
    const parsed = searchTranscriptRequestSchema.parse({
      audioId: options.audioId,
      query: normalized,
      limit: options.limit ?? 200,
    });
    return this.repository.searchTranscript(parsed);
  }

  editSegment(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    text: string;
    expectedRevision: number;
  }): AudioWorkspaceSnapshot {
    const parsed = editAudioSegmentRequestSchema.parse({
      ...command,
      text: command.text.trim(),
    });
    this.repository.editSegment({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.audioId);
  }

  undo(
    audioId: number,
    generationId: number,
    expectedRevision: number,
  ): AudioWorkspaceSnapshot {
    const parsed = audioHistoryRequestSchema.parse({
      audioId,
      generationId,
      expectedRevision,
    });
    this.repository.undo(
      parsed.audioId,
      parsed.generationId,
      parsed.expectedRevision,
      this.now(),
    );
    return this.requireSnapshot(audioId);
  }

  redo(
    audioId: number,
    generationId: number,
    expectedRevision: number,
  ): AudioWorkspaceSnapshot {
    const parsed = audioHistoryRequestSchema.parse({
      audioId,
      generationId,
      expectedRevision,
    });
    this.repository.redo(
      parsed.audioId,
      parsed.generationId,
      parsed.expectedRevision,
      this.now(),
    );
    return this.requireSnapshot(audioId);
  }

  renameSpeaker(command: {
    audioId: number;
    generationId: number;
    speakerId: number;
    name: string;
    expectedRevision: number;
  }): AudioWorkspaceSnapshot {
    const parsed = renameAudioSpeakerRequestSchema.parse({
      ...command,
      name: command.name.trim(),
    });
    this.repository.renameSpeaker({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.audioId);
  }

  mergeSpeakers(command: {
    audioId: number;
    generationId: number;
    targetSpeakerId: number;
    sourceSpeakerIds: number[];
    expectedRevision: number;
  }): AudioWorkspaceSnapshot {
    const parsed = mergeAudioSpeakersRequestSchema.parse(command);
    this.repository.mergeSpeakers({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.audioId);
  }

  assignSpeaker(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    state: "assigned" | "overlap" | "unknown";
    speakerId: number | null;
    expectedRevision: number;
  }): AudioWorkspaceSnapshot {
    const parsed = assignAudioSpeakerRequestSchema.parse(command);
    this.repository.assignSpeaker({ ...parsed, nowMs: this.now() });
    return this.requireSnapshot(command.audioId);
  }

  private requireSnapshot(audioId: number): AudioWorkspaceSnapshot {
    const snapshot = this.repository.openAudio(audioId);
    if (!snapshot) throw new Error("audio workspace is unavailable");
    return snapshot;
  }
}
