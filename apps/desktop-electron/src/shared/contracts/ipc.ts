import { z } from "zod";

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
  operationEvent: "desktop.processing.event.v1",
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
    workerSha256: z.string().regex(/^[a-f0-9]{64}$/),
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

export const operationEventSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    jobId: z.number().int().positive(),
    state: z.enum([
      "queued",
      "running",
      "canceling",
      "canceled",
      "interrupted",
      "completed",
      "failed",
    ]),
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
export type DesktopError = z.infer<typeof desktopErrorSchema>;

export interface Voice2TextDesktopApi {
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
  onOperationEvent(listener: (event: OperationEvent) => void): () => void;
}
