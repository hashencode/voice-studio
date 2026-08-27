import { randomUUID } from "node:crypto";

import type { MicrophoneTestSnapshot } from "../../../shared/contracts";
import {
  MicrophoneTestNativeError,
  type CaptureNativePort,
} from "./capture_native_port";

export type MicrophoneTestNativePort = Pick<
  CaptureNativePort,
  | "startMicrophoneTest"
  | "microphoneTestSnapshot"
  | "finishMicrophoneTest"
  | "cancelMicrophoneTest"
>;

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
    generation: number;
    snapshot: MicrophoneTestSnapshot;
  } | null = null;
  private terminal: {
    testId: string;
    ownerId: number;
    snapshot: MicrophoneTestSnapshot;
  } | null = null;
  private nextGeneration = 0;

  constructor(private readonly native: MicrophoneTestNativePort) {}

  async start(options: {
    ownerId: number;
    microphoneDeviceId?: string;
  }): Promise<MicrophoneTestSnapshot> {
    if (this.active) throw new MicrophoneTestBusyError();
    const testId = `mic-test-${randomUUID()}`;
    const generation = ++this.nextGeneration;
    this.terminal = null;
    this.active = {
      testId,
      ownerId: options.ownerId,
      generation,
      snapshot: emptyRunningSnapshot(testId),
    };
    try {
      return this.acceptSnapshot(
        options.ownerId,
        generation,
        await this.native.startMicrophoneTest(
          testId,
          options.microphoneDeviceId,
        ),
      );
    } catch (error) {
      return this.failActive(options.ownerId, testId, generation, error);
    }
  }

  async snapshot(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    const generation = this.active!.generation;
    try {
      return this.acceptSnapshot(
        options.ownerId,
        generation,
        await this.native.microphoneTestSnapshot(options.testId),
      );
    } catch (error) {
      return this.failActive(
        options.ownerId,
        options.testId,
        generation,
        error,
      );
    }
  }

  async finish(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    const generation = this.active!.generation;
    try {
      return this.acceptSnapshot(
        options.ownerId,
        generation,
        await this.native.finishMicrophoneTest(options.testId),
      );
    } catch (error) {
      return this.failActive(
        options.ownerId,
        options.testId,
        generation,
        error,
      );
    }
  }

  async cancel(options: {
    ownerId: number;
    testId: string;
  }): Promise<MicrophoneTestSnapshot> {
    const settled = this.terminalFor(options);
    if (settled) return settled;
    this.assertOwner(options);
    const generation = this.active!.generation;
    try {
      return this.acceptSnapshot(
        options.ownerId,
        generation,
        await this.native.cancelMicrophoneTest(options.testId),
      );
    } catch (error) {
      return this.failActive(
        options.ownerId,
        options.testId,
        generation,
        error,
      );
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
    generation: number,
    snapshot: MicrophoneTestSnapshot,
  ): MicrophoneTestSnapshot {
    if (
      this.active?.ownerId !== ownerId ||
      this.active.testId !== snapshot.testId ||
      this.active.generation !== generation
    ) {
      return this.terminalFor({ ownerId, testId: snapshot.testId }) ?? snapshot;
    }
    if (snapshot.state === "running") {
      this.active = { testId: snapshot.testId, ownerId, generation, snapshot };
    } else {
      this.active = null;
      this.terminal = { testId: snapshot.testId, ownerId, snapshot };
    }
    return snapshot;
  }

  private failActive(
    ownerId: number,
    testId: string,
    generation: number,
    error: unknown,
  ): MicrophoneTestSnapshot {
    const reason =
      error instanceof MicrophoneTestNativeError && error.kind === "transport"
        ? "native-helper-failed"
        : "snapshot-failed";
    if (
      this.active?.ownerId !== ownerId ||
      this.active.testId !== testId ||
      this.active.generation !== generation
    ) {
      const settled = this.terminalFor({ ownerId, testId });
      if (settled) return settled;
      return failureSnapshot(emptyRunningSnapshot(testId), reason);
    }
    const previous = this.active?.snapshot ?? emptyRunningSnapshot(testId);
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
