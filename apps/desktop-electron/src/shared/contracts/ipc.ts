import { z } from "zod";

import {
  processingTaskPhaseSchema,
  processingTaskSchema,
  processingTaskStateSchema,
  sha256Schema,
} from "./import_processing";
import type {
  ExportAudioResponse,
  AudioExportFormat,
  AudioPlaybackSnapshot,
  AudioSegment,
  AudioSummary,
  AudioWorkspaceSnapshot,
  PlaybackAction,
} from "./audio_workspace";
import { audioAiErrorCodeSchema, type AudioAiErrorCode } from "./audio_ai";
import type {
  CapturePreflight,
  CaptureRecoveryActionResponse,
  CaptureRecoveryItem,
  CaptureSnapshot,
  RenameCaptureSessionRequest,
  SuggestCaptureTitleResponse,
} from "./capture";
import type { MicrophoneTestSnapshot } from "./capture";
import type {
  FloatingCaptureControlRequest,
  FloatingCapturePreference,
  FloatingCaptureSnapshot,
  FloatingCaptureWindowAction,
} from "./floating_capture";
import type {
  CaptionFormalRetryRequest,
  CaptionSnapshot,
  CaptionSnapshotRequest,
} from "./captions";
import type {
  AiSettingsSnapshot,
  CreateAiProviderProfileRequest,
  DeleteAiProviderProfileRequest,
  GenerateAudioAiRequest,
  SelectAiProviderProfileRequest,
  AudioAiConsentPreview,
  AudioAiSnapshot,
  RetryAudioAiRequest,
  UpdateAiProviderProfileRequest,
} from "./audio_ai";
import type {
  CompanionOptInRequest,
  CompanionPairingInviteRequest,
  CompanionPeerRevokeRequest,
  CompanionSnapshot,
  CompanionTransferCancelRequest,
  CompanionTransferRetryRequest,
} from "./companion";
import type { LocalModelIntent, LocalModelSnapshot } from "./local_models";

export const desktopProtocolVersion = 3 as const;
export const desktopWorkerHealthProtocolVersion = 1 as const;
export const desktopWorkerHealthProtocol =
  "desktop-sherpa-worker-health/v1" as const;

export const ipcChannels = {
  applicationSnapshot: "desktop.application.snapshot.v1",
  applicationNavigate: "desktop.application.navigate.v1",
  applicationBootstrapAction: "desktop.application.bootstrap-action.v1",
  applicationActivityMarkRead: "desktop.application.activity.mark-read.v1",
  applicationActivityMarkAllRead:
    "desktop.application.activity.mark-all-read.v1",
  applicationSnapshotEvent: "desktop.application.snapshot-event.v1",
  captureDetailsRequestedEvent: "desktop.capture.details-requested-event.v1",
  workerHealth: "desktop.worker.health.v1",
  cancelProcessing: "desktop.processing.cancel.v1",
  retryProcessing: "desktop.processing.retry.v1",
  startTranscription: "desktop.processing.start-transcription.v1",
  processingTasks: "desktop.processing.tasks.v1",
  importAudio: "desktop.importing.choose-and-import-audio.v2",
  operationEvent: "desktop.processing.event.v1",
  audioList: "desktop.audio.list.v2",
  audioOpen: "desktop.audio.open.v2",
  audioSearch: "desktop.audio.search.v2",
  audioEditSegment: "desktop.audio.edit-segment.v2",
  audioUndo: "desktop.audio.undo.v2",
  audioRedo: "desktop.audio.redo.v2",
  audioRenameSpeaker: "desktop.audio.rename-speaker.v2",
  audioMergeSpeakers: "desktop.audio.merge-speakers.v2",
  audioAssignSpeaker: "desktop.audio.assign-speaker.v2",
  audioPlayback: "desktop.audio.playback.v2",
  audioExport: "desktop.audio.export.v2",
  capturePreflight: "desktop.capture.preflight.v1",
  captureStart: "desktop.capture.start.v1",
  captureControl: "desktop.capture.control.v1",
  captureTitleSuggest: "desktop.capture.title-suggest.v1",
  captureSessionRename: "desktop.capture.session-rename.v1",
  captureRecoveryList: "desktop.capture.recovery-list.v1",
  captureRecoveryAction: "desktop.capture.recovery-action.v1",
  microphoneTestStart: "desktop.capture.microphone-test.start.v1",
  microphoneTestSnapshot: "desktop.capture.microphone-test.snapshot.v1",
  microphoneTestFinish: "desktop.capture.microphone-test.finish.v1",
  microphoneTestCancel: "desktop.capture.microphone-test.cancel.v1",
  microphoneSettingsOpen: "desktop.capture.microphone-settings.open.v1",
  floatingCaptureSnapshotGet: "desktop.floating-capture.snapshot.get.v1",
  floatingCaptureControl: "desktop.floating-capture.control.v1",
  floatingCaptureWindowAction: "desktop.floating-capture.window-action.v1",
  floatingCaptureSnapshotEvent: "desktop.floating-capture.snapshot-event.v1",
  floatingCapturePreferenceGet: "desktop.floating-capture.preference.get.v1",
  floatingCapturePreferenceSet: "desktop.floating-capture.preference.set.v1",
  captionSnapshotGet: "desktop.captions.snapshot.get.v1",
  captionFormalRetry: "desktop.captions.formal.retry.v1",
  captionSnapshotEvent: "desktop.captions.snapshot.v1",
  aiSettingsGet: "desktop.ai.settings.get.v2",
  aiProviderProfileCreate: "desktop.ai.provider-profile.create.v1",
  aiProviderProfileUpdate: "desktop.ai.provider-profile.update.v1",
  aiProviderProfileSelect: "desktop.ai.provider-profile.select.v1",
  aiProviderProfileDelete: "desktop.ai.provider-profile.delete.v1",
  audioAiPrepare: "desktop.ai.audio.prepare.v2",
  audioAiSnapshotGet: "desktop.ai.audio.snapshot.get.v2",
  audioAiGenerate: "desktop.ai.audio.generate.v2",
  audioAiRetry: "desktop.ai.audio.retry.v2",
  audioAiSnapshotEvent: "desktop.ai.audio.snapshot.v2",
  companionSnapshotGet: "desktop.companion.snapshot.get.v1",
  companionOptInSet: "desktop.companion.opt-in.set.v1",
  companionPairingInviteCreate: "desktop.companion.pairing-invite.create.v1",
  companionPeerRevoke: "desktop.companion.peer.revoke.v1",
  companionTransferCancel: "desktop.companion.transfer.cancel.v1",
  companionTransferRetry: "desktop.companion.transfer.retry.v1",
  companionSnapshotEvent: "desktop.companion.snapshot.v1",
  localModelsSnapshotGet: "desktop.local-models.snapshot.get.v1",
  localModelsIntent: "desktop.local-models.intent.v1",
  localModelsChangeRoot: "desktop.local-models.change-root.v1",
  localModelsOpenRoot: "desktop.local-models.open-root.v1",
  localModelsSnapshotEvent: "desktop.local-models.snapshot.v1",
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

export const startTranscriptionRequestSchema = z
  .object({ audioId: z.number().int().positive() })
  .strict();

export const startTranscriptionResponseSchema = retryProcessingResponseSchema;

export const processingTasksRequestSchema = z
  .object({ expectedProtocolVersion: z.literal(desktopProtocolVersion) })
  .strict();

export const processingTasksResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    tasks: z.array(processingTaskSchema).max(10_000),
  })
  .strict();

export const importAudioRequestSchema = z.object({}).strict();

export const importAudioResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(desktopProtocolVersion),
      state: z.literal("canceled"),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(desktopProtocolVersion),
      state: z.literal("imported"),
      audioId: z.number().int().positive(),
      mediaSha256: sha256Schema,
      inserted: z.boolean(),
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

const desktopFailureBaseSchema = z.object({
  protocolVersion: z.literal(desktopProtocolVersion),
  retryable: z.boolean(),
  fallback: z.enum(["try-again", "reload", "continue", "restart-application"]),
  completionCertainty: z
    .enum(["completed", "not-completed", "unknown"])
    .optional(),
  dataDurability: z
    .enum(["durable", "unchanged", "at-risk", "unknown"])
    .optional(),
});

export const desktopFailureSchema = z.discriminatedUnion("domain", [
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("transport"),
      code: z.enum([
        "IPC_DISCONNECTED",
        "INVALID_RESPONSE",
        "PROTOCOL_MISMATCH",
      ]),
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("internal"),
      code: z.literal("INTERNAL_ERROR"),
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("application"),
      code: z.literal("APPLICATION_UNAVAILABLE"),
      applicationAvailability: z.literal("unavailable"),
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("local-model"),
      code: z.literal("MODEL_BUSY"),
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("audio-workspace"),
      code: z.literal("WORKSPACE_CONFLICT"),
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("ai-provider"),
      code: audioAiErrorCodeSchema,
    })
    .strict(),
  desktopFailureBaseSchema
    .extend({
      domain: z.literal("companion-transfer"),
      code: z.enum([
        "COMPANION_TRANSFER_CONFLICT",
        "COMPANION_CHUNK_CONFLICT",
        "COMPANION_CHECKPOINT_EXPIRED",
        "COMPANION_TRANSFER_NOT_FOUND",
        "COMPANION_RECEIPT_MISMATCH",
      ]),
    })
    .strict(),
]);

export const desktopIpcFailureEnvelopeSchema = z
  .object({ ok: z.literal(false), failure: desktopFailureSchema })
  .strict();

export function desktopIpcSuccessEnvelopeSchema<T extends z.ZodType>(
  valueSchema: T,
) {
  return z.object({ ok: z.literal(true), value: valueSchema }).strict();
}

export type DesktopFailureData = z.infer<typeof desktopFailureSchema>;

export class DesktopFailure extends Error {
  readonly data: DesktopFailureData;
  readonly protocolVersion: typeof desktopProtocolVersion;
  readonly domain: DesktopFailureData["domain"];
  readonly code: DesktopFailureData["code"];
  readonly retryable: boolean;
  readonly fallback: DesktopFailureData["fallback"];
  readonly completionCertainty?: DesktopFailureData["completionCertainty"];
  readonly dataDurability?: DesktopFailureData["dataDurability"];
  readonly applicationAvailability?: "unavailable";

  constructor(data: DesktopFailureData) {
    super(`Desktop operation failed (${data.domain}/${data.code})`);
    this.name = "DesktopFailure";
    this.data = Object.freeze({ ...data }) as DesktopFailureData;
    this.protocolVersion = data.protocolVersion;
    this.domain = data.domain;
    this.code = data.code;
    this.retryable = data.retryable;
    this.fallback = data.fallback;
    this.completionCertainty = data.completionCertainty;
    this.dataDurability = data.dataDurability;
    this.applicationAvailability =
      data.domain === "application" ? data.applicationAvailability : undefined;
  }
}

export function unwrapDesktopIpcEnvelope<T extends z.ZodType>(
  payload: unknown,
  valueSchema: T,
): z.infer<T> {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "ok" in payload &&
    payload.ok === false
  ) {
    const parsed = desktopIpcFailureEnvelopeSchema.safeParse(payload);
    if (parsed.success) throw new DesktopFailure(parsed.data.failure);
    throw desktopTransportFailure("INVALID_RESPONSE");
  }
  const parsed =
    desktopIpcSuccessEnvelopeSchema(valueSchema).safeParse(payload);
  if (parsed.success) {
    return (parsed.data as { ok: true; value: z.output<T> }).value;
  }
  const versionedValue =
    typeof payload === "object" &&
    payload !== null &&
    "ok" in payload &&
    payload.ok === true &&
    "value" in payload
      ? payload.value
      : payload;
  if (
    typeof versionedValue === "object" &&
    versionedValue !== null &&
    "protocolVersion" in versionedValue &&
    versionedValue.protocolVersion !== desktopProtocolVersion
  ) {
    throw desktopTransportFailure("PROTOCOL_MISMATCH");
  }
  throw desktopTransportFailure("INVALID_RESPONSE");
}

export function desktopTransportFailure(
  code: "IPC_DISCONNECTED" | "INVALID_RESPONSE" | "PROTOCOL_MISMATCH",
): DesktopFailure {
  return new DesktopFailure({
    protocolVersion: desktopProtocolVersion,
    domain: "transport",
    code,
    retryable: true,
    fallback:
      code === "PROTOCOL_MISMATCH" ? "restart-application" : "try-again",
  });
}

export type WorkerHealthResponse = z.infer<typeof workerHealthResponseSchema>;
export type CancelProcessingResponse = z.infer<
  typeof cancelProcessingResponseSchema
>;
export type OperationEvent = z.infer<typeof operationEventSchema>;
export type ProcessingTaskDelta = z.infer<typeof processingTaskDeltaSchema>;
export type RetryProcessingResponse = z.infer<
  typeof retryProcessingResponseSchema
>;
export type StartTranscriptionResponse = z.infer<
  typeof startTranscriptionResponseSchema
>;
export type ImportAudioResponse = z.infer<typeof importAudioResponseSchema>;
export type DesktopIpcFailureEnvelope = z.infer<
  typeof desktopIpcFailureEnvelopeSchema
>;
export type { AudioAiErrorCode };

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
  getLocalModelSnapshot(): Promise<LocalModelSnapshot>;
  sendLocalModelIntent(options: LocalModelIntent): Promise<LocalModelSnapshot>;
  changeLocalModelRoot(options: {
    expectedRevision: number;
  }): Promise<LocalModelSnapshot>;
  openLocalModelRoot(): Promise<void>;
  onLocalModelSnapshot(
    listener: (snapshot: LocalModelSnapshot) => void,
  ): () => void;
  getAiSettings(): Promise<AiSettingsSnapshot>;
  createAiProviderProfile(
    options: CreateAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot>;
  updateAiProviderProfile(
    options: UpdateAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot>;
  selectAiProviderProfile(
    options: SelectAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot>;
  deleteAiProviderProfile(
    options: DeleteAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot>;
  prepareAudioAi(options: {
    audioId: number;
    generationId: number;
    templateId: string;
  }): Promise<AudioAiConsentPreview>;
  getAudioAiSnapshot(options: {
    audioId: number;
  }): Promise<AudioAiSnapshot | null>;
  generateAudioAi(options: GenerateAudioAiRequest): Promise<AudioAiSnapshot>;
  retryAudioAi(options: RetryAudioAiRequest): Promise<AudioAiSnapshot>;
  onAudioAiSnapshot(listener: (snapshot: AudioAiSnapshot) => void): () => void;
  getApplicationSnapshot(): Promise<
    import("./application_state").ApplicationSnapshot
  >;
  navigate(
    section: import("./application_state").ShellSection,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  requestBootstrapAction(
    action: import("./application_state").BootstrapAction,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  markActivityRead(
    activityId: string,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  markAllActivityRead(): Promise<
    import("./application_state").ApplicationSnapshot
  >;
  onApplicationSnapshot(
    listener: (
      snapshot: import("./application_state").ApplicationSnapshot,
    ) => void,
  ): () => void;
  onCaptureDetailsRequested?(listener: () => void): () => void;
  workerHealth(): Promise<WorkerHealthResponse>;
  cancelProcessing(jobId: number): Promise<CancelProcessingResponse>;
  retryProcessing(
    jobId: number,
    expectedAttempt: number,
  ): Promise<RetryProcessingResponse>;
  startTranscription(audioId: number): Promise<StartTranscriptionResponse>;
  listProcessingTasks(): Promise<
    import("./import_processing").ProcessingTask[]
  >;
  importAudio(): Promise<ImportAudioResponse>;
  onOperationEvent(listener: (event: OperationEvent) => void): () => void;
  listAudios(
    query?: string,
    limit?: number,
    offset?: number,
  ): Promise<AudioSummary[]>;
  openAudio(audioId: number): Promise<AudioWorkspaceSnapshot | null>;
  searchTranscript(
    audioId: number,
    query: string,
    limit?: number,
  ): Promise<AudioSegment[]>;
  editAudioSegment(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    text: string;
    expectedRevision: number;
  }): Promise<AudioWorkspaceSnapshot>;
  undoAudioEdit(
    audioId: number,
    generationId: number,
    expectedRevision: number,
  ): Promise<AudioWorkspaceSnapshot>;
  redoAudioEdit(
    audioId: number,
    generationId: number,
    expectedRevision: number,
  ): Promise<AudioWorkspaceSnapshot>;
  renameAudioSpeaker(command: {
    audioId: number;
    generationId: number;
    speakerId: number;
    name: string;
    expectedRevision: number;
  }): Promise<AudioWorkspaceSnapshot>;
  mergeAudioSpeakers(command: {
    audioId: number;
    generationId: number;
    targetSpeakerId: number;
    sourceSpeakerIds: number[];
    expectedRevision: number;
  }): Promise<AudioWorkspaceSnapshot>;
  assignAudioSpeaker(command: {
    audioId: number;
    generationId: number;
    segmentId: number;
    state: "assigned" | "overlap" | "unknown";
    speakerId: number | null;
    expectedRevision: number;
  }): Promise<AudioWorkspaceSnapshot>;
  controlAudioPlayback(
    audioId: number,
    command: PlaybackAction,
  ): Promise<AudioPlaybackSnapshot>;
  exportAudio(
    audioId: number,
    format: AudioExportFormat,
  ): Promise<ExportAudioResponse>;
  preflightCapture(options: {
    requestPermissions: boolean;
    captionEnabled: boolean;
  }): Promise<CapturePreflight>;
  startCapture(options: {
    title: string;
    refreshSuggestedTitle?: boolean;
    microphoneDeviceId?: string;
    captionEnabled: boolean;
    idempotencyKey: string;
  }): Promise<CaptureSnapshot>;
  controlCapture(options: {
    action: "pause" | "resume" | "stop";
    sessionId: string;
    idempotencyKey: string;
  }): Promise<CaptureSnapshot>;
  suggestCaptureTitle(): Promise<SuggestCaptureTitleResponse>;
  renameCaptureSession(
    options: RenameCaptureSessionRequest,
  ): Promise<import("./application_state").ApplicationSnapshot>;
  listCaptureRecoveries(): Promise<CaptureRecoveryItem[]>;
  actOnCaptureRecovery(options: {
    action: "keep" | "discard";
    sessionIds: string[];
    idempotencyKey: string;
  }): Promise<CaptureRecoveryActionResponse>;
  startMicrophoneTest(options: {
    microphoneDeviceId?: string;
  }): Promise<MicrophoneTestSnapshot>;
  getMicrophoneTestSnapshot(testId: string): Promise<MicrophoneTestSnapshot>;
  finishMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
  cancelMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
  openMicrophoneSettings(): Promise<{ state: "opened" | "failed" }>;
  getFloatingCapturePreference?(): Promise<FloatingCapturePreference>;
  setFloatingCapturePreference?(
    enabled: boolean,
  ): Promise<FloatingCapturePreference>;
  getCaptionSnapshot(
    options: CaptionSnapshotRequest,
  ): Promise<CaptionSnapshot | null>;
  retryFormalTranscript(
    options: CaptionFormalRetryRequest,
  ): Promise<CaptionSnapshot>;
  onCaptionSnapshot(listener: (snapshot: CaptionSnapshot) => void): () => void;
}

export interface Voice2TextFloatingApi {
  getSnapshot(): Promise<FloatingCaptureSnapshot>;
  control(
    options: FloatingCaptureControlRequest,
  ): Promise<FloatingCaptureSnapshot>;
  windowAction(
    action: FloatingCaptureWindowAction,
  ): Promise<FloatingCaptureSnapshot>;
  onSnapshot(listener: (snapshot: FloatingCaptureSnapshot) => void): () => void;
}
