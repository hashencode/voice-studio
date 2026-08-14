import { z } from "zod";

export const meetingWorkspaceLimits = Object.freeze({
  meetingWindow: 500,
  transcriptSegments: 200_000,
  searchResults: 500,
  queryCharacters: 512,
  segmentTextCharacters: 1_000_000,
  speakerNameCharacters: 120,
});

export const meetingProcessingStateSchema = z.enum([
  "queued",
  "running",
  "canceling",
  "canceled",
  "interrupted",
  "completed",
  "failed",
  "partial-success",
]);
export const meetingGenerationKindSchema = z.enum(["formal", "live-draft"]);
export const meetingReviewStateSchema = z.enum([
  "unreviewed",
  "needs-review",
  "reviewed",
]);
export const meetingSpeakerStateSchema = z.enum([
  "assigned",
  "overlap",
  "unknown",
]);
export const meetingExportFormatSchema = z.enum([
  "txt",
  "md",
  "vtt",
  "srt",
  "json",
]);

export const meetingSummarySchema = z
  .object({
    meetingId: z.number().int().positive(),
    displayName: z.string().min(1).max(256),
    durationMs: z.number().int().nonnegative(),
    createdAtMs: z.number().int().nonnegative(),
    processingState: meetingProcessingStateSchema,
    generationId: z.number().int().positive().nullable(),
    generationKind: meetingGenerationKindSchema.nullable(),
    segmentCount: z.number().int().nonnegative(),
  })
  .strict();

export const meetingSpeakerSchema = z
  .object({
    id: z.number().int().positive(),
    stableKey: z.string().min(1).max(256),
    displayName: z
      .string()
      .min(1)
      .max(meetingWorkspaceLimits.speakerNameCharacters),
    source: z.enum(["machine", "manual"]),
    mergedIntoSpeakerId: z.number().int().positive().nullable(),
  })
  .strict();

export const meetingSegmentSchema = z
  .object({
    id: z.number().int().positive(),
    stableKey: z.string().min(1).max(256),
    sequenceId: z.number().int().nonnegative(),
    text: z.string().min(1).max(meetingWorkspaceLimits.segmentTextCharacters),
    machineText: z
      .string()
      .min(1)
      .max(meetingWorkspaceLimits.segmentTextCharacters),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    reviewState: meetingReviewStateSchema,
    speakerState: meetingSpeakerStateSchema,
    speakerId: z.number().int().positive().nullable(),
    speakerName: z.string().min(1).max(120).nullable(),
    speakerSource: z.enum(["machine", "manual"]),
  })
  .strict();

export const meetingWorkspaceSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    summary: meetingSummarySchema,
    segments: z
      .array(meetingSegmentSchema)
      .max(meetingWorkspaceLimits.transcriptSegments),
    speakers: z.array(meetingSpeakerSchema).max(10_000),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();

export const listMeetingsRequestSchema = z
  .object({
    query: z.string().max(meetingWorkspaceLimits.queryCharacters).default(""),
    limit: z
      .number()
      .int()
      .min(1)
      .max(meetingWorkspaceLimits.meetingWindow)
      .default(200),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export const listMeetingsResponseSchema = z
  .object({
    meetings: z
      .array(meetingSummarySchema)
      .max(meetingWorkspaceLimits.meetingWindow),
  })
  .strict();
export const openMeetingRequestSchema = z
  .object({ meetingId: z.number().int().positive() })
  .strict();
export const openMeetingResponseSchema =
  meetingWorkspaceSnapshotSchema.nullable();
export const searchTranscriptRequestSchema = z
  .object({
    meetingId: z.number().int().positive(),
    query: z.string().min(1).max(meetingWorkspaceLimits.queryCharacters),
    limit: z
      .number()
      .int()
      .min(1)
      .max(meetingWorkspaceLimits.searchResults)
      .default(200),
  })
  .strict();
export const searchTranscriptResponseSchema = z
  .object({
    segments: z
      .array(meetingSegmentSchema)
      .max(meetingWorkspaceLimits.searchResults),
  })
  .strict();

const mutationIdentityShape = {
  meetingId: z.number().int().positive(),
  generationId: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
};
export const editMeetingSegmentRequestSchema = z
  .object({
    ...mutationIdentityShape,
    segmentId: z.number().int().positive(),
    text: z.string().min(1).max(meetingWorkspaceLimits.segmentTextCharacters),
  })
  .strict();
export const meetingHistoryRequestSchema = z
  .object({
    meetingId: z.number().int().positive(),
    generationId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const renameMeetingSpeakerRequestSchema = z
  .object({
    ...mutationIdentityShape,
    speakerId: z.number().int().positive(),
    name: z.string().min(1).max(meetingWorkspaceLimits.speakerNameCharacters),
  })
  .strict();
export const mergeMeetingSpeakersRequestSchema = z
  .object({
    ...mutationIdentityShape,
    targetSpeakerId: z.number().int().positive(),
    sourceSpeakerIds: z.array(z.number().int().positive()).min(1).max(100),
  })
  .strict();
export const assignMeetingSpeakerRequestSchema = z
  .object({
    ...mutationIdentityShape,
    segmentId: z.number().int().positive(),
    state: meetingSpeakerStateSchema,
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
export const controlMeetingPlaybackRequestSchema = z
  .object({
    meetingId: z.number().int().positive(),
    command: playbackActionSchema,
  })
  .strict();
export const meetingPlaybackSnapshotSchema = z
  .object({
    meetingId: z.number().int().positive().nullable(),
    initialized: z.boolean(),
    playing: z.boolean(),
    positionMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    speed: z.number().min(0.5).max(2),
    error: z.string().max(512).nullable(),
  })
  .strict();
export const exportMeetingRequestSchema = z
  .object({
    meetingId: z.number().int().positive(),
    format: meetingExportFormatSchema,
  })
  .strict();
export const exportMeetingResponseSchema = z.discriminatedUnion("state", [
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

export type MeetingSummary = z.infer<typeof meetingSummarySchema>;
export type MeetingSpeaker = z.infer<typeof meetingSpeakerSchema>;
export type MeetingSegment = z.infer<typeof meetingSegmentSchema>;
export type MeetingWorkspaceSnapshot = z.infer<
  typeof meetingWorkspaceSnapshotSchema
>;
export type MeetingReviewState = z.infer<typeof meetingReviewStateSchema>;
export type MeetingSpeakerState = z.infer<typeof meetingSpeakerStateSchema>;
export type MeetingExportFormat = z.infer<typeof meetingExportFormatSchema>;
export type PlaybackAction = z.infer<typeof playbackActionSchema>;
export type MeetingPlaybackSnapshot = z.infer<
  typeof meetingPlaybackSnapshotSchema
>;
export type ExportMeetingResponse = z.infer<typeof exportMeetingResponseSchema>;
