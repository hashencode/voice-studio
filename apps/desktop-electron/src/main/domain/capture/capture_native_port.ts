import type {
  CaptureControlCommand,
  CapturePreflight,
  CaptureRuntimeSnapshot,
  CaptureSnapshot,
  CaptureStartCommand,
  MicrophoneTestSnapshot,
} from "../../../shared/contracts";

export class MicrophoneTestNativeError extends Error {
  constructor(
    readonly kind: "transport" | "response",
    options?: ErrorOptions,
  ) {
    super(`microphone test native ${kind} failure`, options);
    this.name = "MicrophoneTestNativeError";
  }
}

export type CaptureNativeStopFailureKind = "command" | "transport";

export class CaptureNativeStopError extends Error {
  constructor(
    readonly kind: CaptureNativeStopFailureKind,
    options?: ErrorOptions,
  ) {
    super(`capture stop native ${kind} failure`, options);
    this.name = "CaptureNativeStopError";
  }
}

export interface CaptureNativePort {
  preflight(command: {
    minimumFreeBytes: number;
    captionModelAvailable: boolean;
    requestPermissions: boolean;
  }): Promise<CapturePreflight>;
  start(command: CaptureStartCommand): Promise<CaptureRuntimeSnapshot>;
  pause(command: CaptureControlCommand): Promise<CaptureRuntimeSnapshot>;
  resume(command: CaptureControlCommand): Promise<CaptureRuntimeSnapshot>;
  stop(command: CaptureControlCommand): Promise<CaptureRuntimeSnapshot>;
  systemSleep(command: CaptureControlCommand): Promise<CaptureRuntimeSnapshot>;
  systemWake(command: CaptureControlCommand): Promise<CaptureRuntimeSnapshot>;
  snapshot(sessionId: string): Promise<CaptureRuntimeSnapshot>;
  recover(): Promise<CaptureSnapshot[]>;
  discard(sessionId: string, idempotencyKey: string): Promise<void>;
  startMicrophoneTest(
    testId: string,
    microphoneDeviceId?: string,
  ): Promise<MicrophoneTestSnapshot>;
  microphoneTestSnapshot(testId: string): Promise<MicrophoneTestSnapshot>;
  finishMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
  cancelMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
  recreateAfterTransportLoss?(): Promise<void>;
  abort?(): void;
}
