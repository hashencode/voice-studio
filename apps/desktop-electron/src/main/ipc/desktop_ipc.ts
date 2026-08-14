import type { ZodType } from "zod";
import { fileURLToPath } from "node:url";

import {
  bootstrapActionRequestSchema,
  cancelProcessingRequestSchema,
  retryProcessingRequestSchema,
  processingTasksRequestSchema,
  importMeetingRequestSchema,
  desktopProtocolVersion,
  getApplicationSnapshotRequestSchema,
  ipcChannels,
  navigateRequestSchema,
  workerHealthRequestSchema,
  type ApplicationSnapshot,
  type BootstrapAction,
  type CancelProcessingResponse,
  type RetryProcessingResponse,
  type ImportMeetingResponse,
  type ProcessingTask,
  type OperationEvent,
  type ShellSection,
  type WorkerHealthResponse,
  listMeetingsRequestSchema,
  openMeetingRequestSchema,
  searchTranscriptRequestSchema,
  editMeetingSegmentRequestSchema,
  meetingHistoryRequestSchema,
  renameMeetingSpeakerRequestSchema,
  mergeMeetingSpeakersRequestSchema,
  assignMeetingSpeakerRequestSchema,
  controlMeetingPlaybackRequestSchema,
  exportMeetingRequestSchema,
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
  type ExportMeetingResponse,
  type MeetingExportFormat,
  type MeetingPlaybackSnapshot,
  type MeetingSegment,
  type MeetingSummary,
  type MeetingWorkspaceSnapshot,
  type PlaybackAction,
  getAiSettingsRequestSchema,
  saveAiSettingsRequestSchema,
  replaceAiProviderSecretRequestSchema,
  deleteAiProviderSecretRequestSchema,
  prepareMeetingAiRequestSchema,
  getMeetingAiSnapshotRequestSchema,
  generateMeetingAiRequestSchema,
  retryMeetingAiRequestSchema,
  type AiSettingsSnapshot,
  type GenerateMeetingAiRequest,
  type MeetingAiConsentPreview,
  type MeetingAiSnapshot,
  type RetryMeetingAiRequest,
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
  onMeetingAiSnapshot?(
    listener: (snapshot: MeetingAiSnapshot) => void,
  ): () => void;
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
  importMeeting(): Promise<ImportMeetingResponse>;
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
  listMeetings(options: {
    query: string;
    limit: number;
    offset: number;
  }): Promise<MeetingSummary[]>;
  openMeeting(meetingId: number): Promise<MeetingWorkspaceSnapshot | null>;
  searchTranscript(options: {
    meetingId: number;
    query: string;
    limit: number;
  }): Promise<MeetingSegment[]>;
  editMeetingSegment(
    command: Parameters<
      import("../domain/workspace/meeting_workspace_service").MeetingWorkspaceService["editSegment"]
    >[0],
  ): Promise<MeetingWorkspaceSnapshot>;
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
  renameMeetingSpeaker(
    command: Parameters<
      import("../domain/workspace/meeting_workspace_service").MeetingWorkspaceService["renameSpeaker"]
    >[0],
  ): Promise<MeetingWorkspaceSnapshot>;
  mergeMeetingSpeakers(
    command: Parameters<
      import("../domain/workspace/meeting_workspace_service").MeetingWorkspaceService["mergeSpeakers"]
    >[0],
  ): Promise<MeetingWorkspaceSnapshot>;
  assignMeetingSpeaker(
    command: Parameters<
      import("../domain/workspace/meeting_workspace_service").MeetingWorkspaceService["assignSpeaker"]
    >[0],
  ): Promise<MeetingWorkspaceSnapshot>;
  controlMeetingPlayback(
    meetingId: number,
    command: PlaybackAction,
  ): Promise<MeetingPlaybackSnapshot>;
  exportMeeting(
    meetingId: number,
    format: MeetingExportFormat,
  ): Promise<ExportMeetingResponse>;
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
      ipcChannels.meetingAiPrepare,
      {
        schema: prepareMeetingAiRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["prepareMeetingAi"]>[0],
        ) => options.services.prepareMeetingAi(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingAiSnapshotGet,
      {
        schema: getMeetingAiSnapshotRequestSchema,
        invoke: async (
          payload: Parameters<DesktopIpcServices["getMeetingAiSnapshot"]>[0],
        ) => options.services.getMeetingAiSnapshot(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingAiGenerate,
      {
        schema: generateMeetingAiRequestSchema,
        invoke: async (payload: GenerateMeetingAiRequest) =>
          options.services.generateMeetingAi(payload),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingAiRetry,
      {
        schema: retryMeetingAiRequestSchema,
        invoke: async (payload: RetryMeetingAiRequest) =>
          options.services.retryMeetingAi(payload),
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
      ipcChannels.importMeeting,
      {
        schema: importMeetingRequestSchema,
        invoke: async () => await options.services.importMeeting(),
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
      ipcChannels.meetingList,
      {
        schema: listMeetingsRequestSchema,
        invoke: async (payload: {
          query: string;
          limit: number;
          offset: number;
        }) => ({
          meetings: await options.services.listMeetings(payload),
        }),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingOpen,
      {
        schema: openMeetingRequestSchema,
        invoke: async (payload: { meetingId: number }) =>
          await options.services.openMeeting(payload.meetingId),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingSearch,
      {
        schema: searchTranscriptRequestSchema,
        invoke: async (payload: {
          meetingId: number;
          query: string;
          limit: number;
        }) => ({
          segments: await options.services.searchTranscript(payload),
        }),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingEditSegment,
      {
        schema: editMeetingSegmentRequestSchema,
        invoke: async (payload: never) =>
          await options.services.editMeetingSegment(payload),
      },
    ],
    [
      ipcChannels.meetingUndo,
      {
        schema: meetingHistoryRequestSchema,
        invoke: async (payload: {
          meetingId: number;
          generationId: number;
          expectedRevision: number;
        }) =>
          await options.services.undoMeetingEdit(
            payload.meetingId,
            payload.generationId,
            payload.expectedRevision,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingRedo,
      {
        schema: meetingHistoryRequestSchema,
        invoke: async (payload: {
          meetingId: number;
          generationId: number;
          expectedRevision: number;
        }) =>
          await options.services.redoMeetingEdit(
            payload.meetingId,
            payload.generationId,
            payload.expectedRevision,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingRenameSpeaker,
      {
        schema: renameMeetingSpeakerRequestSchema,
        invoke: async (payload: never) =>
          await options.services.renameMeetingSpeaker(payload),
      },
    ],
    [
      ipcChannels.meetingMergeSpeakers,
      {
        schema: mergeMeetingSpeakersRequestSchema,
        invoke: async (payload: never) =>
          await options.services.mergeMeetingSpeakers(payload),
      },
    ],
    [
      ipcChannels.meetingAssignSpeaker,
      {
        schema: assignMeetingSpeakerRequestSchema,
        invoke: async (payload: never) =>
          await options.services.assignMeetingSpeaker(payload),
      },
    ],
    [
      ipcChannels.meetingPlayback,
      {
        schema: controlMeetingPlaybackRequestSchema,
        invoke: async (payload: {
          meetingId: number;
          command: PlaybackAction;
        }) =>
          await options.services.controlMeetingPlayback(
            payload.meetingId,
            payload.command,
          ),
      } as RegisteredHandler,
    ],
    [
      ipcChannels.meetingExport,
      {
        schema: exportMeetingRequestSchema,
        invoke: async (payload: {
          meetingId: number;
          format: MeetingExportFormat;
        }) =>
          await options.services.exportMeeting(
            payload.meetingId,
            payload.format,
          ),
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
