import { z } from "zod";

export const desktopProtocolVersion = 1 as const;

export const ipcChannels = {
  workerHealth: "desktop.worker.health.v1",
} as const;

export const workerHealthRequestSchema = z
  .object({
    expectedProtocolVersion: z.literal(desktopProtocolVersion),
  })
  .strict();

export const workerHealthResponseSchema = z
  .object({
    protocolVersion: z.literal(desktopProtocolVersion),
    protocol: z.literal("desktop-sherpa-worker-health/v1"),
    runtime: z.literal("sherpa-onnx"),
    workerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type WorkerHealthResponse = z.infer<typeof workerHealthResponseSchema>;

export interface Voice2TextDesktopApi {
  workerHealth(): Promise<WorkerHealthResponse>;
}
