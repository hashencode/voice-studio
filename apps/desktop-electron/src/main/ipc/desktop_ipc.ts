import type { ZodType } from "zod";

import {
  bootstrapActionRequestSchema,
  cancelProcessingRequestSchema,
  desktopProtocolVersion,
  getApplicationSnapshotRequestSchema,
  ipcChannels,
  navigateRequestSchema,
  workerHealthRequestSchema,
  type ApplicationSnapshot,
  type BootstrapAction,
  type CancelProcessingResponse,
  type ShellSection,
  type WorkerHealthResponse,
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
  applicationSnapshot(): ApplicationSnapshot;
  navigate(section: ShellSection): ApplicationSnapshot;
  requestBootstrapAction(action: BootstrapAction): Promise<ApplicationSnapshot>;
  onApplicationSnapshot?(
    listener: (snapshot: ApplicationSnapshot) => void,
  ): () => void;
  workerHealth(): Promise<WorkerHealthResponse>;
  cancelProcessing(jobId: number): Promise<CancelProcessingResponse>;
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

function assertTrustedInvocation(
  event: IpcInvocationContext,
  trust: IpcTrustPolicy,
): void {
  if (
    event.senderId !== trust.senderId ||
    event.frameId !== trust.frameId ||
    !isTrustedLocation(event.origin, trust)
  ) {
    throw new IpcContractError(
      "UNTRUSTED_SENDER",
      "IPC sender, frame, or origin is not trusted",
    );
  }
}

function isTrustedLocation(value: string, trust: IpcTrustPolicy): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "file:"
      ? (trust.fileUrls?.has(url.href) ?? false)
      : trust.origins.has(url.origin);
  } catch (error) {
    throw new IpcContractError("UNTRUSTED_SENDER", "IPC origin is invalid", {
      cause: error,
    });
  }
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
