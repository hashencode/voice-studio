import type {
  CaptureControlCommand,
  CaptureStartCommand,
} from "../../../shared/contracts";
import type { MacOSNativeHelperSession } from "../../features/importing/macos_native_helper_client";
import type { CaptureNativePort } from "./capture_native_port";

export class MacOSCaptureNativePort implements CaptureNativePort {
  constructor(private readonly session: MacOSNativeHelperSession) {}

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

  stop(command: CaptureControlCommand) {
    return this.session.captureControl(command);
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

  startMicrophoneTest(testId: string, microphoneDeviceId?: string) {
    return this.session.startMicrophoneTest(testId, microphoneDeviceId);
  }

  microphoneTestSnapshot(testId: string) {
    return this.session.microphoneTestSnapshot(testId);
  }

  stopMicrophoneTest(testId: string) {
    return this.session.stopMicrophoneTest(testId);
  }
}
