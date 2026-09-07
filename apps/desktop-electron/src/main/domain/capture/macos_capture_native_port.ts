import type {
  CaptureControlCommand,
  CaptureStartCommand,
} from "../../../shared/contracts";
import {
  NativeHelperCommandError,
  NativeHelperTransportError,
  type MacOSNativeHelperSession,
} from "../../features/importing/macos_native_helper_client";
import {
  CaptureNativeStopError,
  MicrophoneTestNativeError,
  type CaptureNativePort,
} from "./capture_native_port";

export class MacOSCaptureNativePort implements CaptureNativePort {
  constructor(
    private session: MacOSNativeHelperSession,
    private readonly reopenSession?: () => Promise<MacOSNativeHelperSession>,
  ) {}

  preflight(command: Parameters<CaptureNativePort["preflight"]>[0]) {
    return this.session.capturePreflight(command);
  }

  start(command: CaptureStartCommand) {
    return this.session.captureStart(command);
  }

  pause(command: CaptureControlCommand) {
    return this.session.captureControl(command);
  }

  resume(command: CaptureControlCommand) {
    return this.session.captureControl(command);
  }

  async stop(command: CaptureControlCommand) {
    try {
      return await this.session.captureControl(command);
    } catch (error) {
      throw new CaptureNativeStopError(
        error instanceof NativeHelperCommandError ? "command" : "transport",
        { cause: error },
      );
    }
  }

  systemSleep(command: CaptureControlCommand) {
    return this.session.captureLifecycle(
      "system-sleep",
      command.sessionId,
      command.idempotencyKey,
    );
  }

  systemWake(command: CaptureControlCommand) {
    return this.session.captureLifecycle(
      "system-wake",
      command.sessionId,
      command.idempotencyKey,
    );
  }

  snapshot(sessionId: string) {
    return this.session.captureSnapshot(sessionId);
  }

  recover() {
    return this.session.captureRecover();
  }

  discard(sessionId: string, idempotencyKey: string) {
    return this.session.captureDiscard(sessionId, idempotencyKey);
  }

  async recreateAfterTransportLoss(): Promise<void> {
    if (!this.reopenSession) {
      throw new Error("capture native session cannot be recreated");
    }
    this.session.abort();
    this.session = await this.reopenSession();
  }

  abort(): void {
    this.session.abort();
  }

  currentSession(): MacOSNativeHelperSession {
    return this.session;
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async startMicrophoneTest(testId: string, microphoneDeviceId?: string) {
    return await this.microphoneCommand(() =>
      this.session.startMicrophoneTest(testId, microphoneDeviceId),
    );
  }

  async microphoneTestSnapshot(testId: string) {
    return await this.microphoneCommand(() =>
      this.session.microphoneTestSnapshot(testId),
    );
  }

  async finishMicrophoneTest(testId: string) {
    return await this.microphoneCommand(() =>
      this.session.finishMicrophoneTest(testId),
    );
  }

  async cancelMicrophoneTest(testId: string) {
    return await this.microphoneCommand(() =>
      this.session.cancelMicrophoneTest(testId),
    );
  }

  private async microphoneCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new MicrophoneTestNativeError(
        error instanceof NativeHelperTransportError ? "transport" : "response",
        { cause: error },
      );
    }
  }
}
