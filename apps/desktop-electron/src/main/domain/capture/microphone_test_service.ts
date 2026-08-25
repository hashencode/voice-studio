import { randomUUID } from "node:crypto";

import type { MicrophoneTestSnapshot } from "../../../shared/contracts";
import type { CaptureNativePort } from "./capture_native_port";

export class MicrophoneTestBusyError extends Error {
  constructor() {
    super("麦克风正在被其他操作使用");
    this.name = "MicrophoneTestBusyError";
  }
}

/** Main-owned singleton. Renderer routes never own or directly open a device. */
export class MicrophoneTestService {
  private active: { testId: string; ownerId: number } | null = null;

  constructor(private readonly native: CaptureNativePort) {}

  async start(options: {
    ownerId: number;
    microphoneDeviceId?: string;
  }): Promise<MicrophoneTestSnapshot> {
    if (this.active) throw new MicrophoneTestBusyError();
    const testId = `mic-test-${randomUUID()}`;
    const snapshot = await this.native.startMicrophoneTest(
      testId,
      options.microphoneDeviceId,
    );
    this.active = { testId, ownerId: options.ownerId };
    return snapshot;
  }

  async snapshot(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    this.assertOwner(options);
    const snapshot = await this.native.microphoneTestSnapshot(options.testId);
    if (snapshot.state !== "running") this.active = null;
    return snapshot;
  }

  async stop(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    this.assertOwner(options);
    try {
      return await this.native.stopMicrophoneTest(options.testId);
    } finally {
      this.active = null;
    }
  }

  async stopForOwner(ownerId: number): Promise<void> {
    if (this.active?.ownerId !== ownerId) return;
    await this.stopActiveTest();
  }

  async stopBeforeFormalCapture(): Promise<void> {
    if (!this.active) return;
    await this.stopActiveTest();
  }

  private async stopActiveTest(): Promise<void> {
    const testId = this.active?.testId;
    this.active = null;
    if (testId)
      await this.native.stopMicrophoneTest(testId).catch(() => undefined);
  }

  private assertOwner(options: { ownerId: number; testId: string }): void {
    if (
      this.active?.ownerId !== options.ownerId ||
      this.active.testId !== options.testId
    ) {
      throw new Error("麦克风测试已结束或不属于当前窗口");
    }
  }
}
