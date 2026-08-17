import type { ZodType } from "zod";
import { fileURLToPath } from "node:url";

import {
  bootstrapActionRequestSchema,
  cancelProcessingRequestSchema,
  retryProcessingRequestSchema,
  processingTasksRequestSchema,
  importAudioRequestSchema,
  desktopProtocolVersion,
  getApplicationSnapshotRequestSchema,
  ipcChannels,
  navigateRequestSchema,
  workerHealthRequestSchema,
  type ApplicationSnapshot,
  type BootstrapAction,
  type CancelProcessingResponse,
  type RetryProcessingResponse,
  type ImportAudioResponse,
  type ProcessingTask,
  type OperationEvent,
  type ShellSection,
  type WorkerHealthResponse,
  listAudiosRequestSchema,
  openAudioRequestSchema,
  searchTranscriptRequestSchema,
  editAudioSegmentRequestSchema,
  audioHistoryRequestSchema,
  renameAudioSpeakerRequestSchema,
  mergeAudioSpeakersRequestSchema,
  assignAudioSpeakerRequestSchema,
  controlAudioPlaybackRequestSchema,
  exportAudioRequestSchema,
  capturePreflightRequestSchema,
  captureStartRequestSchema,
  captureControlRequestSchema,
  captureRecoveryListRequestSchema,
  captureRecoveryActionRequestSchema,
  type CapturePreflight,
  type CaptureSnapshot,
  captionSnapshotRequestSchema,
  captionFormalRetryRequestSchema,
  type CaptionFormalRetryRequest,
  type CaptionSnapshot,
  type CaptionSnapshotRequest,
  type ExportAudioResponse,
  type AudioExportFormat,
  type AudioPlaybackSnapshot,
  type AudioSegment,
  type AudioSummary,
  type AudioWorkspaceSnapshot,
  type PlaybackAction,
  getAiSettingsRequestSchema,
  saveAiSettingsRequestSchema,
  replaceAiProviderSecretRequestSchema,
  deleteAiProviderSecretRequestSchema,
  prepareAudioAiRequestSchema,
  getAudioAiSnapshotRequestSchema,
  generateAudioAiRequestSchema,
  retryAudioAiRequestSchema,
  type AiSettingsSnapshot,
  type GenerateAudioAiRequest,
  type AudioAiConsentPreview,
  type AudioAiSnapshot,
  type RetryAudioAiRequest,
  companionSnapshotRequestSchema,
  companionOptInRequestSchema,
  companionPairingInviteRequestSchema,
  companionPeerRevokeRequestSchema,
  companionTransferCancelRequestSchema,
  companionTransferRetryRequestSchema,
  type CompanionOptInRequest,
  type CompanionPairingInviteRequest,
  type CompanionPeerRevokeRequest,
  type CompanionSnapshot,
  type CompanionTransferCancelRequest,
  type CompanionTransferRetryRequest,
} from "../../shared/contracts";

export interface IpcInvocationContext {
  senderId: number;
  frameId: number;
  origin: string;
}

export interface IpcTrustPolicy {
  senderId: number;
  frameId: number;
  origins: ReadonlySet<string>;
  fileUrls?: ReadonlySet<string>;
}

export interface DesktopIpcServices {
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
  onCompanionSnapshot?(
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
  onAudioAiSnapshot?(listener: (snapshot: AudioAiSnapshot) => void): () => void;
  applicationSnapshot(): ApplicationSnapshot;
  navigate(section: ShellSection): ApplicationSnapshot;
  requestBootstrapAction(action: BootstrapAction): Promise<ApplicationSnapshot>;
  onApplicationSnapshot?(
    listener: (snapshot: ApplicationSnapshot) => void,
  ): () => void;
  workerHealth(): Promise<WorkerHealthResponse>;
  cancelProcessing(jobId: number): Promise<CancelProcessingResponse>;
  retryProcessing(
    jobId: number,
    expectedAttempt: number,
  ): Promise<RetryProcessingResponse>;
  listProcessingTasks(): Promise<ProcessingTask[]>;
  importAudio(): Promise<ImportAudioResponse>;
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
  onCaptionSnapshot?(listener: (snapshot: CaptionSnapshot) => void): () => void;
  onOperationEvent?(listener: (event: OperationEvent) => void): () => void;
  listAudios(options: {
    query: string;
    limit: number;
    offset: number;
  }): Promise<AudioSummary[]>;
  openAudio(audioId: number): Promise<AudioWorkspaceSnapshot | null>;
  searchTranscript(options: {
    audioId: number;
    query: string;
    limit: number;
  }): Promise<AudioSegment[]>;
  editAudioSegment(
    command: Parameters<
      import("../domain/workspace/audio_workspace_service").AudioWorkspaceService["editSegment"]
    >[0],
  ): Promise<AudioWorkspaceSnapshot>;
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
  renameAudioSpeaker(
    command: Parameters<
      import("../domain/workspace/audio_workspace_service").AudioWorkspaceService["renameSpeaker"]
    >[0],
  ): Promise<AudioWorkspaceSnapshot>;
  mergeAudioSpeakers(
    command: Parameters<
      import("../domain/workspace/audio_workspace_service").AudioWorkspaceService["mergeSpeakers"]
    >[0],
  ): Promise<AudioWorkspaceSnapshot>;
  assignAudioSpeaker(
    command: Parameters<
      import("../domain/workspace/audio_workspace_service").AudioWorkspaceService["assignSpeaker"]
    >[0],
  ): Promise<AudioWorkspaceSnapshot>;
  controlAudioPlayback(
    audioId: number,
    command: PlaybackAction,
  ): Promise<AudioPlaybackSnapshot>;
  exportAudio(
    audioId: number,
    format: AudioExportFormat,
  ): Promise<ExportAudioResponse>;
}

export class IpcContractError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_CHANNEL"
      | "UNTRUSTED_SENDER"
      | "INVALID_PAYLOAD"
      | "PAYLOAD_TOO_LARGE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IpcContractError";
  }
}

type RegisteredHandler = {
  schema: ZodType;
  invoke(payload: never): Promise<unknown>;
};

export class DesktopIpcHandlers {
  constructor(
    private readonly trust: IpcTrustPolicy,
    private readonly handlers: ReadonlyMap<string, RegisteredHandler>,
    private readonly maximumPayloadBytes: number,
  ) {}

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  async invoke(
    channel: string,
    event: IpcInvocationContext,
    payload: unknown,
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new IpcContractError(
        "UNKNOWN_CHANNEL",
        "IPC channel is not allowlisted",
      );
    }
    assertTrustedInvocation(event, this.trust);
    assertPayloadEnvelope(payload, this.maximumPayloadBytes);
    const parsed = handler.schema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcContractError(
        "INVALID_PAYLOAD",
        "IPC payload failed runtime validation",
        { cause: parsed.error },
      );
    }
    return await handler.invoke(parsed.data as never);
  }
}

export function createDesktopIpcHandlers(options: {
  trust: IpcTrustPolicy;
  services: DesktopIpcServices;
  maximumPayloadBytes?: number;
}): DesktopIpcHandlers {
  const handlers = new Map<string, RegisteredHandler>([
    [
      ipcChannels.companionSnapshotGet,
      {
        schema: companionSnapshotRequestSchema,
        invoke: async () => options.services.getCompanionSnapshot(),
      },
    ],
    [
      ipcChannels.companionOptInSet,
      {
        schema: companionOptInRequestSchema,
        invoke: async (payload: CompanionOptInRequest) =>
          options.services.setCompanionOptIn(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.companionPairingInviteCreate,
      {
        schema: companionPairingInviteRequestSchema,
        invoke: async (payload: CompanionPairingInviteRequest) =>
          options.services.createCompanionPairingInvite(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.companionPeerRevoke,
      {
        schema: companionPeerRevokeRequestSchema,
        invoke: async (payload: CompanionPeerRevokeRequest) =>
          options.services.revokeCompanionPeer(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.companionTransferCancel,
      {
        schema: companionTransferCancelRequestSchema,
        invoke: async (payload: CompanionTransferCancelRequest) =>
          options.services.cancelCompanionTransfer(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.companionTransferRetry,
      {
        schema: companionTransferRetryRequestSchema,
        invoke: async (payload: CompanionTransferRetryRequest) =>
          options.services.retryCompanionTransfer(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.aiSettingsGet,
      {
        schema: getAiSettingsRequestSchema,
        invoke: async () => options.services.getAiSettings(),
      },
    ],
    [
      ipcChannels.aiSettingsSave,
      {
        schema: saveAiSettingsRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["saveAiSettings"]>[0],
        ) => options.services.saveAiSettings(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.aiSecretReplace,
      {
        schema: replaceAiProviderSecretRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["replaceAiProviderSecret"]>[0],
        ) => options.services.replaceAiProviderSecret(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.aiSecretDelete,
      {
        schema: deleteAiProviderSecretRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["deleteAiProviderSecret"]>[0],
        ) => options.services.deleteAiProviderSecret(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioAiPrepare,
      {
        schema: prepareAudioAiRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["prepareAudioAi"]>[0],
        ) => options.services.prepareAudioAi(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioAiSnapshotGet,
      {
        schema: getAudioAiSnapshotRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["getAudioAiSnapshot"]>[0],
        ) => options.services.getAudioAiSnapshot(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioAiGenerate,
      {
        schema: generateAudioAiRequestSchema,
        invoke: async (payload: GenerateAudioAiRequest) =>
          options.services.generateAudioAi(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioAiRetry,
      {
        schema: retryAudioAiRequestSchema,
        invoke: async (payload: RetryAudioAiRequest) =>
          options.services.retryAudioAi(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.applicationSnapshot,
      {
        schema: getApplicationSnapshotRequestSchema,
        invoke: async () => options.services.applicationSnapshot(),
      },
    ],
    [
      ipcChannels.applicationNavigate,
      {
        schema: navigateRequestSchema,
        invoke: async (payload: { section: ShellSection }) =>
          options.services.navigate(payload.section),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.applicationBootstrapAction,
      {
        schema: bootstrapActionRequestSchema,
        invoke: async (payload: { action: BootstrapAction }) =>
          await options.services.requestBootstrapAction(payload.action),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.workerHealth,
      {
        schema: workerHealthRequestSchema,
        invoke: async () => await options.services.workerHealth(),
      },
    ],
    [
      ipcChannels.cancelProcessing,
      {
        schema: cancelProcessingRequestSchema,
        invoke: async (payload: { jobId: number }) =>
          await options.services.cancelProcessing(payload.jobId),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.retryProcessing,
      {
        schema: retryProcessingRequestSchema,
        invoke: async (payload: { jobId: number; expectedAttempt: number }) =>
          await options.services.retryProcessing(
            payload.jobId,
            payload.expectedAttempt,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.processingTasks,
      {
        schema: processingTasksRequestSchema,
        invoke: async () => ({
          protocolVersion: desktopProtocolVersion,
          tasks: await options.services.listProcessingTasks(),
        }),
      },
    ],
    [
      ipcChannels.importAudio,
      {
        schema: importAudioRequestSchema,
        invoke: async () => await options.services.importAudio(),
      },
    ],
    [
      ipcChannels.capturePreflight,
      {
        schema: capturePreflightRequestSchema,
        invoke: async (payload: {
          requestPermissions: boolean;
          captionEnabled: boolean;
        }) => await options.services.preflightCapture(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.captureStart,
      {
        schema: captureStartRequestSchema,
        invoke: async (payload: {
          title: string;
          microphoneDeviceId?: string;
          captionEnabled: boolean;
          idempotencyKey: string;
        }) => await options.services.startCapture(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.captureControl,
      {
        schema: captureControlRequestSchema,
        invoke: async (payload: {
          action: "pause" | "resume" | "stop";
          sessionId: string;
          idempotencyKey: string;
        }) => await options.services.controlCapture(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.captureRecoveryList,
      {
        schema: captureRecoveryListRequestSchema,
        invoke: async () => await options.services.listCaptureRecoveries(),
      },
    ],
    [
      ipcChannels.captureRecoveryAction,
      {
        schema: captureRecoveryActionRequestSchema,
        invoke: async (payload: {
          action: "keep" | "discard";
          sessionId: string;
          idempotencyKey: string;
        }) => await options.services.actOnCaptureRecovery(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.captionSnapshotGet,
      {
        schema: captionSnapshotRequestSchema,
        invoke: async (payload: CaptionSnapshotRequest) =>
          await options.services.getCaptionSnapshot(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.captionFormalRetry,
      {
        schema: captionFormalRetryRequestSchema,
        invoke: async (payload: CaptionFormalRetryRequest) =>
          await options.services.retryFormalTranscript(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioList,
      {
        schema: listAudiosRequestSchema,
        invoke: async (payload: {
          query: string;
          limit: number;
          offset: number;
        }) => ({
          audios: await options.services.listAudios(payload),
        }),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioOpen,
      {
        schema: openAudioRequestSchema,
        invoke: async (payload: { audioId: number }) =>
          await options.services.openAudio(payload.audioId),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioSearch,
      {
        schema: searchTranscriptRequestSchema,
        invoke: async (payload: {
          audioId: number;
          query: string;
          limit: number;
        }) => ({
          segments: await options.services.searchTranscript(payload),
        }),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioEditSegment,
      {
        schema: editAudioSegmentRequestSchema,
        invoke: async (payload: never) =>
          await options.services.editAudioSegment(payload),
      },
    ],
    [
      ipcChannels.audioUndo,
      {
        schema: audioHistoryRequestSchema,
        invoke: async (payload: {
          audioId: number;
          generationId: number;
          expectedRevision: number;
        }) =>
          await options.services.undoAudioEdit(
            payload.audioId,
            payload.generationId,
            payload.expectedRevision,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioRedo,
      {
        schema: audioHistoryRequestSchema,
        invoke: async (payload: {
          audioId: number;
          generationId: number;
          expectedRevision: number;
        }) =>
          await options.services.redoAudioEdit(
            payload.audioId,
            payload.generationId,
            payload.expectedRevision,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioRenameSpeaker,
      {
        schema: renameAudioSpeakerRequestSchema,
        invoke: async (payload: never) =>
          await options.services.renameAudioSpeaker(payload),
      },
    ],
    [
      ipcChannels.audioMergeSpeakers,
      {
        schema: mergeAudioSpeakersRequestSchema,
        invoke: async (payload: never) =>
          await options.services.mergeAudioSpeakers(payload),
      },
    ],
    [
      ipcChannels.audioAssignSpeaker,
      {
        schema: assignAudioSpeakerRequestSchema,
        invoke: async (payload: never) =>
          await options.services.assignAudioSpeaker(payload),
      },
    ],
    [
      ipcChannels.audioPlayback,
      {
        schema: controlAudioPlaybackRequestSchema,
        invoke: async (payload: { audioId: number; command: PlaybackAction }) =>
          await options.services.controlAudioPlayback(
            payload.audioId,
            payload.command,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.audioExport,
      {
        schema: exportAudioRequestSchema,
        invoke: async (payload: {
          audioId: number;
          format: AudioExportFormat;
        }) =>
          await options.services.exportAudio(payload.audioId, payload.format),
      } as RegisteredHandler,
    ],
  ]);
  return new DesktopIpcHandlers(
    options.trust,
    handlers,
    options.maximumPayloadBytes ?? 64 * 1024,
  );
}

export function canceledResponse(jobId: number): CancelProcessingResponse {
  return { protocolVersion: desktopProtocolVersion, jobId, state: "canceled" };
}

export function queuedResponse(jobId: number): RetryProcessingResponse {
  return { protocolVersion: desktopProtocolVersion, jobId, state: "queued" };
}

function assertTrustedInvocation(
  event: IpcInvocationContext,
  trust: IpcTrustPolicy,
): void {
  const trustedLocation = isTrustedLocation(event.origin, trust);
  if (
    event.senderId !== trust.senderId ||
    event.frameId !== trust.frameId ||
    !trustedLocation
  ) {
    if (process.env.VOICE2TEXT_PROCESSING_SMOKE_OUTPUT) {
      console.error(
        JSON.stringify({
          event: "electron-ipc-trust-mismatch",
          senderMatches: event.senderId === trust.senderId,
          frameMatches: event.frameId === trust.frameId,
          locationMatches: trustedLocation,
          origin: appAsarSuffix(event.origin),
          expected: [...(trust.fileUrls ?? [])].map(appAsarSuffix),
        }),
      );
    }
    throw new IpcContractError(
      "UNTRUSTED_SENDER",
      "IPC sender, frame, or origin is not trusted",
    );
  }
}

function appAsarSuffix(value: string): string {
  const marker = "app.asar/";
  const index = value.indexOf(marker);
  return index < 0 ? "outside-app-asar" : value.slice(index + marker.length);
}

function isTrustedLocation(value: string, trust: IpcTrustPolicy): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return trust.origins.has(url.origin);
    if (url.search || !trustedRendererHash(url.hash)) return false;
    const candidate = fileURLToPath(url);
    return [...(trust.fileUrls ?? [])].some(
      (expected) => fileURLToPath(new URL(expected)) === candidate,
    );
  } catch (error) {
    throw new IpcContractError("UNTRUSTED_SENDER", "IPC origin is invalid", {
      cause: error,
    });
  }
}

function trustedRendererHash(hash: string): boolean {
  return ["", "#/library", "#/tasks", "#/companion", "#/settings"].includes(
    hash,
  );
}

function assertPayloadEnvelope(payload: unknown, maximumBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new IpcContractError(
      "INVALID_PAYLOAD",
      "IPC payload is not serializable",
      { cause: error },
    );
  }
  if (serialized === undefined) {
    throw new IpcContractError(
      "INVALID_PAYLOAD",
      "IPC payload is not serializable",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new IpcContractError(
      "PAYLOAD_TOO_LARGE",
      "IPC payload exceeds the byte limit",
    );
  }
}
