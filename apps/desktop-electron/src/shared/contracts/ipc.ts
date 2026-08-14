import { z } from "zod";

import {
  processingTaskPhaseSchema,
  processingTaskSchema,
  processingTaskStateSchema,
  sha256Schema,
} from "./import_processing";
import type {
  ExportMeetingResponse,
  MeetingExportFormat,
  MeetingPlaybackSnapshot,
  MeetingSegment,
  MeetingSummary,
  MeetingWorkspaceSnapshot,
  PlaybackAction,
} from "./meeting_workspace";
import type { CapturePreflight, CaptureSnapshot } from "./capture";
import type {
  CaptionFormalRetryRequest,
  CaptionSnapshot,
  CaptionSnapshotRequest,
} from "./captions";
import type {
  AiSettingsSnapshot,
  GenerateMeetingAiRequest,
  MeetingAiConsentPreview,
  MeetingAiSnapshot,
  RetryMeetingAiRequest,
} from "./meeting_ai";
import type {
  CompanionOptInRequest,
  CompanionPairingInviteRequest,
  CompanionPeerRevokeRequest,
  CompanionSnapshot,
  CompanionTransferCancelRequest,
  CompanionTransferRetryRequest,
} from "./companion";

export const desktopProtocolVersion = 1 as const;
export const desktopWorkerHealthProtocol =
  "desktop-sherpa-worker-health/v1" as const;

export const ipcChannels = {
  applicationSnapshot: "desktop.application.snapshot.v1",
  applicationNavigate: "desktop.application.navigate.v1",
  applicationBootstrapAction: "desktop.application.bootstrap-action.v1",
  applicationSnapshotEvent: "desktop.application.snapshot-event.v1",
  workerHealth: "desktop.worker.health.v1",
  cancelProcessing: "desktop.processing.cancel.v1",
  retryProcessing: "desktop.processing.retry.v1",
  processingTasks: "desktop.processing.tasks.v1",
  importMeeting: "desktop.importing.choose-and-import.v1",
  operationEvent: "desktop.processing.event.v1",
  meetingList: "desktop.meetings.list.v1",
  meetingOpen: "desktop.meetings.open.v1",
  meetingSearch: "desktop.meetings.search.v1",
  meetingEditSegment: "desktop.meetings.edit-segment.v1",
  meetingUndo: "desktop.meetings.undo.v1",
  meetingRedo: "desktop.meetings.redo.v1",
  meetingRenameSpeaker: "desktop.meetings.rename-speaker.v1",
  meetingMergeSpeakers: "desktop.meetings.merge-speakers.v1",
  meetingAssignSpeaker: "desktop.meetings.assign-speaker.v1",
  meetingPlayback: "desktop.meetings.playback.v1",
  meetingExport: "desktop.meetings.export.v1",
  capturePreflight: "desktop.capture.preflight.v1",
  captureStart: "desktop.capture.start.v1",
  captureControl: "desktop.capture.control.v1",
  captureRecoveryList: "desktop.capture.recovery-list.v1",
  captureRecoveryAction: "desktop.capture.recovery-action.v1",
  captionSnapshotGet: "desktop.captions.snapshot.get.v1",
  captionFormalRetry: "desktop.captions.formal.retry.v1",
  captionSnapshotEvent: "desktop.captions.snapshot.v1",
  aiSettingsGet: "desktop.ai.settings.get.v1",
  aiSettingsSave: "desktop.ai.settings.save.v1",
  aiSecretReplace: "desktop.ai.secret.replace.v1",
  aiSecretDelete: "desktop.ai.secret.delete.v1",
  meetingAiPrepare: "desktop.ai.meeting.prepare.v1",
  meetingAiSnapshotGet: "desktop.ai.meeting.snapshot.get.v1",
  meetingAiGenerate: "desktop.ai.meeting.generate.v1",
  meetingAiRetry: "desktop.ai.meeting.retry.v1",
  meetingAiSnapshotEvent: "desktop.ai.meeting.snapshot.v1",
  companionSnapshotGet: "desktop.companion.snapshot.get.v1",
  companionOptInSet: "desktop.companion.opt-in.set.v1",
  companionPairingInviteCreate: "desktop.companion.pairing-invite.create.v1",
  companionPeerRevoke: "desktop.companion.peer.revoke.v1",
  companionTransferCancel: "desktop.companion.transfer.cancel.v1",
  companionTransferRetry: "desktop.companion.transfer.retry.v1",
  companionSnapshotEvent: "desktop.companion.snapshot.v1",
} as const;

export const workerHealthRequestSchema = z
  .object({
    expectedProtocolVersion: z.literal(desktopProtocolVersion),
  })
  .strict();

export const workerHealthResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    protocol: z.literal(desktopWorkerHealthProtocol),
    runtime: z.literal("sherpa-onnx"),
    workerSha256: sha256Schema,
  })
  .strict();

export const cancelProcessingRequestSchema = z
  .object({ jobId: z.number().int().positive() })
  .strict();

export const cancelProcessingResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    jobId: z.number().int().positive(),
    state: z.literal("canceled"),
  })
  .strict();

export const retryProcessingRequestSchema = z
  .object({
    jobId: z.number().int().positive(),
    expectedAttempt: z.number().int().positive(),
  })
  .strict();

export const retryProcessingResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    jobId: z.number().int().positive(),
    state: z.literal("queued"),
  })
  .strict();

export const processingTasksRequestSchema = z
  .object({ expectedProtocolVersion: z.literal(desktopProtocolVersion) })
  .strict();

export const processingTasksResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    tasks: z.array(processingTaskSchema).max(10_000),
  })
  .strict();

export const importMeetingRequestSchema = z.object({}).strict();

export const importMeetingResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(desktopProtocolVersion),
      state: z.literal("canceled"),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(desktopProtocolVersion),
      state: z.enum([
        "queued",
        "running",
        "canceling",
        "canceled",
        "interrupted",
        "completed",
        "failed",
      ]),
      meetingId: z.number().int().positive(),
      jobId: z.number().int().positive(),
      mediaSha256: sha256Schema,
      inserted: z.boolean(),
      progressFraction: z.number().min(0).max(1),
    })
    .strict(),
]);

export const processingTaskDeltaSchema = z
  .object({
    state: processingTaskStateSchema,
    phase: processingTaskPhaseSchema.optional(),
    progressFraction: z.number().min(0).max(1).optional(),
  })
  .strict();

export const operationEventSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    jobId: z.number().int().positive(),
    attempt: z.number().int().nonnegative(),
    ...processingTaskDeltaSchema.shape,
  })
  .strict();

export const desktopErrorSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    code: z.enum([
      "UNKNOWN_CHANNEL",
      "UNTRUSTED_SENDER",
      "INVALID_PAYLOAD",
      "PAYLOAD_TOO_LARGE",
      "OPERATION_NOT_AVAILABLE",
      "INTERNAL_ERROR",
    ]),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

export type WorkerHealthResponse = z.infer<typeof workerHealthResponseSchema>;
export type CancelProcessingResponse = z.infer<
  typeof cancelProcessingResponseSchema
>;
export type OperationEvent = z.infer<typeof operationEventSchema>;
export type ProcessingTaskDelta = z.infer<typeof processingTaskDeltaSchema>;
export type RetryProcessingResponse = z.infer<
  typeof retryProcessingResponseSchema
>;
export type ImportMeetingResponse = z.infer<typeof importMeetingResponseSchema>;
export type DesktopError = z.infer<typeof desktopErrorSchema>;

export interface Voice2TextDesktopApi {
  getCompanionSnapshot(): Promise<CompanionSnapshot>;
  setCompanionOptIn(options: CompanionOptInRequest): Promise<CompanionSnapshot>;
  createCompanionPairingInvite(
    options: CompanionPairingInviteRequest,
  ): Promise<CompanionSnapshot>;
  revokeCompanionPeer(
    options: CompanionPeerRevokeRequest,
  ): Promise<CompanionSnapshot>;
  cancelCompanionTransfer(
    options: CompanionTransferCancelRequest,
  ): Promise<CompanionSnapshot>;
  retryCompanionTransfer(
    options: CompanionTransferRetryRequest,
  ): Promise<CompanionSnapshot>;
  onCompanionSnapshot(
    listener: (snapshot: CompanionSnapshot) => void,
  ): () => void;
  getAiSettings(): Promise<AiSettingsSnapshot>;
  saveAiSettings(options: {
    providerId: "deepseek" | "openai-compatible";
    modelId: string;
    endpoint: string;
  }): Promise<AiSettingsSnapshot>;
  replaceAiProviderSecret(options: {
    providerId: "deepseek" | "openai-compatible";
    secret: string;
  }): Promise<AiSettingsSnapshot>;
  deleteAiProviderSecret(options: {
    providerId: "deepseek" | "openai-compatible";
  }): Promise<AiSettingsSnapshot>;
  prepareMeetingAi(options: {
    meetingId: number;
    generationId: number;
    templateId: string;
  }): Promise<MeetingAiConsentPreview>;
  getMeetingAiSnapshot(options: {
    meetingId: number;
  }): Promise<MeetingAiSnapshot | null>;
  generateMeetingAi(
    options: GenerateMeetingAiRequest,
  ): Promise<MeetingAiSnapshot>;
  retryMeetingAi(options: RetryMeetingAiRequest): Promise<MeetingAiSnapshot>;
  onMeetingAiSnapshot(
    listener: (snapshot: MeetingAiSnapshot) => void,
  ): () => void;
  getApplicationSnapshot(): Promise<
    import("./application_state").ApplicationSnapshot
  >;
  navigate(
    section: import("./application_state").ShellSection,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  requestBootstrapAction(
    action: import("./application_state").BootstrapAction,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  onApplicationSnapshot(
    listener: (
      snapshot: import("./application_state").ApplicationSnapshot,
    ) => void,
  ): () => void;
  workerHealth(): Promise<WorkerHealthResponse>;
  cancelProcessing(jobId: number): Promise<CancelProcessingResponse>;
  retryProcessing(
    jobId: number,
    expectedAttempt: number,
  ): Promise<RetryProcessingResponse>;
  listProcessingTasks(): Promise<
    import("./import_processing").ProcessingTask[]
  >;
  importMeeting(): Promise<ImportMeetingResponse>;
  onOperationEvent(listener: (event: OperationEvent) => void): () => void;
  listMeetings(
    query?: string,
    limit?: number,
    offset?: number,
  ): Promise<MeetingSummary[]>;
  openMeeting(meetingId: number): Promise<MeetingWorkspaceSnapshot | null>;
  searchTranscript(
    meetingId: number,
    query: string,
    limit?: number,
  ): Promise<MeetingSegment[]>;
  editMeetingSegment(command: {
    meetingId: number;
    generationId: number;
    segmentId: number;
    text: string;
    expectedRevision: number;
  }): Promise<MeetingWorkspaceSnapshot>;
  undoMeetingEdit(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
  ): Promise<MeetingWorkspaceSnapshot>;
  redoMeetingEdit(
    meetingId: number,
    generationId: number,
    expectedRevision: number,
  ): Promise<MeetingWorkspaceSnapshot>;
  renameMeetingSpeaker(command: {
    meetingId: number;
    generationId: number;
    speakerId: number;
    name: string;
    expectedRevision: number;
  }): Promise<MeetingWorkspaceSnapshot>;
  mergeMeetingSpeakers(command: {
    meetingId: number;
    generationId: number;
    targetSpeakerId: number;
    sourceSpeakerIds: number[];
    expectedRevision: number;
  }): Promise<MeetingWorkspaceSnapshot>;
  assignMeetingSpeaker(command: {
    meetingId: number;
    generationId: number;
    segmentId: number;
    state: "assigned" | "overlap" | "unknown";
    speakerId: number | null;
    expectedRevision: number;
  }): Promise<MeetingWorkspaceSnapshot>;
  controlMeetingPlayback(
    meetingId: number,
    command: PlaybackAction,
  ): Promise<MeetingPlaybackSnapshot>;
  exportMeeting(
    meetingId: number,
    format: MeetingExportFormat,
  ): Promise<ExportMeetingResponse>;
  preflightCapture(options: {
    requestPermissions: boolean;
    captionEnabled: boolean;
  }): Promise<CapturePreflight>;
  startCapture(options: {
    title: string;
    microphoneDeviceId?: string;
    captionEnabled: boolean;
    idempotencyKey: string;
  }): Promise<CaptureSnapshot>;
  controlCapture(options: {
    action: "pause" | "resume" | "stop";
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureSnapshot>;
  listCaptureRecoveries(): Promise<CaptureSnapshot[]>;
  actOnCaptureRecovery(options: {
    action: "keep" | "discard";
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureSnapshot | null>;
  getCaptionSnapshot(
    options: CaptionSnapshotRequest,
  ): Promise<CaptionSnapshot | null>;
  retryFormalTranscript(
    options: CaptionFormalRetryRequest,
  ): Promise<CaptionSnapshot>;
  onCaptionSnapshot(listener: (snapshot: CaptionSnapshot) => void): () => void;
}
