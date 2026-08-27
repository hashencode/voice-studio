import { randomUUID } from "node:crypto";

import type { MicrophoneTestSnapshot } from "../../../shared/contracts";
import {
  MicrophoneTestNativeError,
  type CaptureNativePort,
} from "./capture_native_port";

export class MicrophoneTestBusyError extends Error {
  constructor() {
    super("麦克风正在被其他操作使用");
    this.name = "MicrophoneTestBusyError";
  }
}

/** Main-owned singleton. Renderer routes never own or directly open a device. */
export class MicrophoneTestService {
  private active: {
    testId: string;
    ownerId: number;
    snapshot: MicrophoneTestSnapshot;
  } | null = null;
  private terminal: {
    testId: string;
    ownerId: number;
    snapshot: MicrophoneTestSnapshot;
  } | null = null;

  constructor(private readonly native: CaptureNativePort) {}

  async start(options: {
    ownerId: number;
    microphoneDeviceId?: string;
  }): Promise<MicrophoneTestSnapshot> {
    if (this.active) throw new MicrophoneTestBusyError();
    const testId = `mic-test-${randomUUID()}`;
    this.terminal = null;
    this.active = {
      testId,
      ownerId: options.ownerId,
      snapshot: emptyRunningSnapshot(testId),
    };
    try {
      return this.acceptSnapshot(
        options.ownerId,
        await this.native.startMicrophoneTest(
          testId,
          options.microphoneDeviceId,
        ),
      );
    } catch (error) {
      return this.failActive(options.ownerId, testId, error);
    }
  }

  async snapshot(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    try {
      return this.acceptSnapshot(
        options.ownerId,
        await this.native.microphoneTestSnapshot(options.testId),
      );
    } catch (error) {
      return this.failActive(options.ownerId, options.testId, error);
    }
  }

  async finish(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    try {
      return this.acceptSnapshot(
        options.ownerId,
        await this.native.finishMicrophoneTest(options.testId),
      );
    } catch (error) {
      return this.failActive(options.ownerId, options.testId, error);
    }
  }

  async cancel(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    try {
      return this.acceptSnapshot(
        options.ownerId,
        await this.native.cancelMicrophoneTest(options.testId),
      );
    } catch (error) {
      return this.failActive(options.ownerId, options.testId, error);
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
    const active = this.active;
    this.active = null;
    if (!active) return;
    try {
      const snapshot = await this.native.cancelMicrophoneTest(active.testId);
      this.terminal = { ...active, snapshot };
    } catch {
      this.terminal = {
        ...active,
        snapshot: failureSnapshot(active.snapshot, "native-helper-failed"),
      };
    }
  }

  private assertOwner(options: { ownerId: number; testId: string }): void {
    if (
      this.active?.ownerId !== options.ownerId ||
      this.active.testId !== options.testId
    ) {
      throw new Error("麦克风测试已结束或不属于当前窗口");
    }
  }

  private terminalFor(options: {
    ownerId: number;
    testId: string;
  }): MicrophoneTestSnapshot | null {
    return this.terminal?.ownerId === options.ownerId &&
      this.terminal.testId === options.testId
      ? this.terminal.snapshot
      : null;
  }

  private acceptSnapshot(
    ownerId: number,
    snapshot: MicrophoneTestSnapshot,
  ): MicrophoneTestSnapshot {
    if (snapshot.state === "running") {
      this.active = { testId: snapshot.testId, ownerId, snapshot };
    } else {
      this.active = null;
      this.terminal = { testId: snapshot.testId, ownerId, snapshot };
    }
    return snapshot;
  }

  private failActive(
    ownerId: number,
    testId: string,
    error: unknown,
  ): MicrophoneTestSnapshot {
    const previous = this.active?.snapshot ?? emptyRunningSnapshot(testId);
    const reason =
      error instanceof MicrophoneTestNativeError && error.kind === "transport"
        ? "native-helper-failed"
        : "snapshot-failed";
    const snapshot = failureSnapshot(previous, reason);
    this.active = null;
    this.terminal = { testId, ownerId, snapshot };
    return snapshot;
  }
}

function emptyRunningSnapshot(testId: string): MicrophoneTestSnapshot {
  return {
    testId,
    state: "running",
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
}

function failureSnapshot(
  previous: MicrophoneTestSnapshot,
  reason: "native-helper-failed" | "snapshot-failed",
): MicrophoneTestSnapshot {
  return { ...previous, state: "failed", reason };
}
