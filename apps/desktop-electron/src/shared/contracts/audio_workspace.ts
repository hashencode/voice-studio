import { z } from "zod";

export const audioWorkspaceLimits = Object.freeze({
  audioWindow: 500,
  transcriptSegments: 200_000,
  searchResults: 500,
  queryCharacters: 512,
  segmentTextCharacters: 1_000_000,
  speakerNameCharacters: 120,
});

export const audioProcessingStateSchema = z.enum([
  "queued",
  "running",
  "canceling",
  "canceled",
  "interrupted",
  "completed",
  "failed",
  "partial-success",
]);
export const audioGenerationKindSchema = z.enum(["formal", "live-draft"]);
export const audioReviewStateSchema = z.enum([
  "unreviewed",
  "needs-review",
  "reviewed",
]);
export const audioSpeakerStateSchema = z.enum([
  "assigned",
  "overlap",
  "unknown",
]);
export const audioExportFormatSchema = z.enum([
  "txt",
  "md",
  "vtt",
  "srt",
  "json",
]);

export const audioSummarySchema = z
  .object({
    audioId: z.number().int().positive(),
    displayName: z.string().min(1).max(256),
    durationMs: z.number().int().nonnegative(),
    createdAtMs: z.number().int().nonnegative(),
    processingState: audioProcessingStateSchema,
    generationId: z.number().int().positive().nullable(),
    generationKind: audioGenerationKindSchema.nullable(),
    segmentCount: z.number().int().nonnegative(),
  })
  .strict();

export const audioSpeakerSchema = z
  .object({
    id: z.number().int().positive(),
    stableKey: z.string().min(1).max(256),
    displayName: z
      .string()
      .min(1)
      .max(audioWorkspaceLimits.speakerNameCharacters),
    source: z.enum(["machine", "manual"]),
    mergedIntoSpeakerId: z.number().int().positive().nullable(),
  })
  .strict();

export const audioSegmentSchema = z
  .object({
    id: z.number().int().positive(),
    stableKey: z.string().min(1).max(256),
    sequenceId: z.number().int().nonnegative(),
    text: z.string().min(1).max(audioWorkspaceLimits.segmentTextCharacters),
    machineText: z
      .string()
      .min(1)
      .max(audioWorkspaceLimits.segmentTextCharacters),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    reviewState: audioReviewStateSchema,
    speakerState: audioSpeakerStateSchema,
    speakerId: z.number().int().positive().nullable(),
    speakerName: z.string().min(1).max(120).nullable(),
    speakerSource: z.enum(["machine", "manual"]),
  })
  .strict();

export const audioWorkspaceSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    summary: audioSummarySchema,
    segments: z
      .array(audioSegmentSchema)
      .max(audioWorkspaceLimits.transcriptSegments),
    speakers: z.array(audioSpeakerSchema).max(10_000),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();

export const listAudiosRequestSchema = z
  .object({
    query: z.string().max(audioWorkspaceLimits.queryCharacters).default(""),
    limit: z
      .number()
      .int()
      .min(1)
      .max(audioWorkspaceLimits.audioWindow)
      .default(200),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export const listAudiosResponseSchema = z
  .object({
    audios: z.array(audioSummarySchema).max(audioWorkspaceLimits.audioWindow),
  })
  .strict();
export const openAudioRequestSchema = z
  .object({ audioId: z.number().int().positive() })
  .strict();
export const openAudioResponseSchema = audioWorkspaceSnapshotSchema.nullable();
export const searchTranscriptRequestSchema = z
  .object({
    audioId: z.number().int().positive(),
    query: z.string().min(1).max(audioWorkspaceLimits.queryCharacters),
    limit: z
      .number()
      .int()
      .min(1)
      .max(audioWorkspaceLimits.searchResults)
      .default(200),
  })
  .strict();
export const searchTranscriptResponseSchema = z
  .object({
    segments: z
      .array(audioSegmentSchema)
      .max(audioWorkspaceLimits.searchResults),
  })
  .strict();

const mutationIdentityShape = {
  audioId: z.number().int().positive(),
  generationId: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
};
export const editAudioSegmentRequestSchema = z
  .object({
    ...mutationIdentityShape,
    segmentId: z.number().int().positive(),
    text: z.string().min(1).max(audioWorkspaceLimits.segmentTextCharacters),
  })
  .strict();
export const audioHistoryRequestSchema = z
  .object({
    audioId: z.number().int().positive(),
    generationId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const renameAudioSpeakerRequestSchema = z
  .object({
    ...mutationIdentityShape,
    speakerId: z.number().int().positive(),
    name: z.string().min(1).max(audioWorkspaceLimits.speakerNameCharacters),
  })
  .strict();
export const mergeAudioSpeakersRequestSchema = z
  .object({
    ...mutationIdentityShape,
    targetSpeakerId: z.number().int().positive(),
    sourceSpeakerIds: z.array(z.number().int().positive()).min(1).max(100),
  })
  .strict();
export const assignAudioSpeakerRequestSchema = z
  .object({
    ...mutationIdentityShape,
    segmentId: z.number().int().positive(),
    state: audioSpeakerStateSchema,
    speakerId: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "assigned") !== (value.speakerId !== null)) {
      context.addIssue({
        code: "custom",
        message: "assigned state and speaker identity disagree",
      });
    }
  });

export const playbackActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }).strict(),
  z.object({ action: z.literal("play") }).strict(),
  z.object({ action: z.literal("pause") }).strict(),
  z
    .object({
      action: z.literal("seek"),
      positionMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ action: z.literal("speed"), speed: z.number().min(0.5).max(2) })
    .strict(),
  z.object({ action: z.literal("close") }).strict(),
]);
export const controlAudioPlaybackRequestSchema = z
  .object({
    audioId: z.number().int().positive(),
    command: playbackActionSchema,
  })
  .strict();
export const audioPlaybackSnapshotSchema = z
  .object({
    audioId: z.number().int().positive().nullable(),
    initialized: z.boolean(),
    playing: z.boolean(),
    positionMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    speed: z.number().min(0.5).max(2),
    error: z.string().max(512).nullable(),
  })
  .strict();
export const exportAudioRequestSchema = z
  .object({
    audioId: z.number().int().positive(),
    format: audioExportFormatSchema,
  })
  .strict();
export const exportAudioResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("canceled") }).strict(),
  z
    .object({
      state: z.literal("failed"),
      code: z.literal("export-write-failed"),
      message: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({ state: z.literal("saved"), fileName: z.string().min(1).max(512) })
    .strict(),
]);

export type AudioSummary = z.infer<typeof audioSummarySchema>;
export type AudioSpeaker = z.infer<typeof audioSpeakerSchema>;
export type AudioSegment = z.infer<typeof audioSegmentSchema>;
export type AudioWorkspaceSnapshot = z.infer<
  typeof audioWorkspaceSnapshotSchema
>;
export type AudioReviewState = z.infer<typeof audioReviewStateSchema>;
export type AudioSpeakerState = z.infer<typeof audioSpeakerStateSchema>;
export type AudioExportFormat = z.infer<typeof audioExportFormatSchema>;
export type PlaybackAction = z.infer<typeof playbackActionSchema>;
export type AudioPlaybackSnapshot = z.infer<typeof audioPlaybackSnapshotSchema>;
export type ExportAudioResponse = z.infer<typeof exportAudioResponseSchema>;
