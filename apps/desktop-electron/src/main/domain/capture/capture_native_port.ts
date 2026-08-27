import type {
  CaptureControlCommand,
  CapturePreflight,
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

export interface CaptureNativePort {
  preflight(command: {
    minimumFreeBytes: number;
    captionModelAvailable: boolean;
    requestPermissions: boolean;
  }): Promise<CapturePreflight>;
  start(command: CaptureStartCommand): Promise<CaptureSnapshot>;
  pause(command: CaptureControlCommand): Promise<CaptureSnapshot>;
  resume(command: CaptureControlCommand): Promise<CaptureSnapshot>;
  stop(command: CaptureControlCommand): Promise<CaptureSnapshot>;
  systemSleep(command: CaptureControlCommand): Promise<CaptureSnapshot>;
  systemWake(command: CaptureControlCommand): Promise<CaptureSnapshot>;
  snapshot(sessionId: string): Promise<CaptureSnapshot>;
  recover(): Promise<CaptureSnapshot[]>;
  discard(sessionId: string, idempotencyKey: string): Promise<void>;
  startMicrophoneTest(
    testId: string,
    microphoneDeviceId?: string,
  ): Promise<MicrophoneTestSnapshot>;
  microphoneTestSnapshot(testId: string): Promise<MicrophoneTestSnapshot>;
  finishMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
  cancelMicrophoneTest(testId: string): Promise<MicrophoneTestSnapshot>;
}
